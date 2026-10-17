/**
 * 粘贴导入：把一段 JSON / JSONC 变成「可预览的一行行」。
 *
 * 为什么解析要放在契约层、且是**纯函数**（参考 ai-result-evaluation 的 mcp-paste）：
 *   · 预览与落盘必须用**同一份**判定，否则「预览说覆盖、实际新增」只能靠肉眼发现；
 *   · 解析不碰 IO、不碰框架 ⇒ 设置页只负责把结果画出来，判据全在这里钉得住；
 *   · 贴进来的配置五花八门（Claude / Cursor / VS Code / Zed / OpenCode / Gemini CLI…），
 *     一旦开始「看起来像就当成…」，用户拿到的就是一份自己没打算要的配置。
 *
 * 三层职责（别互相越界）：
 *   1. `stripJsonComments` —— JSONC 容错（注释 / 尾逗号 / BOM），字符串里的 `//` 不许动；
 *   2. `parseMcpImport` —— 形状判别 + 方言字段归一 + 条目化 + 上限，产出预览要的每一格；
 *   3. `applyMcpImport` / `mcpImportNameIssue` —— 合并语义与改名校验，界面与用例共用同一份口径。
 *
 * ⚠️ 上限（256 KB / 100 条）**先于解析**拦下：先解析再数条数的话，一段 10 MB 的贴入会先把
 * 主线程占满，用户看到的是「界面卡住」而不是「太大了」。
 */
import { McpServerSchema, type McpServer, type McpTransport } from './mcp';
import { optionTakesValue } from './mcp-launcher';

/** 贴入文本的字节上限（256 KB）：超过它连剥离都不做，直接给中文原因 */
export const MCP_IMPORT_MAX_BYTES = 256 * 1024;

/** 一次导入的条目数上限：够覆盖手工维护的清单，又挡得住误贴进来的整份配置文件 */
export const MCP_IMPORT_MAX_ENTRIES = 100;

/** 识别到的形状：界面用它告诉用户「这份 JSON 被当成了哪种方言」 */
export type McpImportStyle =
  | 'mcpServers'
  | 'servers'
  | 'context_servers'
  | 'mcp'
  | 'mcp_servers'
  | 'amp'
  | 'array'
  | 'single'
  | 'map';

export const MCP_IMPORT_STYLE_LABELS: Record<McpImportStyle, string> = {
  mcpServers: 'mcpServers 信封（Claude Desktop / Cursor / Windsurf / Cline…）',
  servers: 'servers 信封（VS Code / Continue）',
  context_servers: 'context_servers 信封（Zed）',
  mcp: 'mcp 信封（OpenCode）',
  mcp_servers: 'mcp_servers 信封',
  amp: 'amp.mcpServers 信封（Amp）',
  array: '数组（本应用及通用写法）',
  single: '单台服务器',
  map: 'name-keyed map（无信封）',
};

/** 界面上的示例按钮：每条都必须自己能通过 `parseMcpImport`（守卫会逐条喂回） */
export interface McpImportShapeExample {
  label: string;
  text: string;
}

export const MCP_IMPORT_SHAPE_EXAMPLES: readonly McpImportShapeExample[] = [
  {
    label: 'Claude / Cursor',
    text: '{\n  "mcpServers": {\n    "context7": { "url": "https://mcp.context7.com/mcp" }\n  }\n}',
  },
  {
    label: 'VS Code',
    text: '{\n  "servers": {\n    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }\n  },\n  "inputs": []\n}',
  },
  {
    label: '本应用数组',
    text: '[\n  { "name": "context7", "transport": "http", "url": "https://mcp.context7.com/mcp" }\n]',
  },
  {
    label: 'Zed',
    text: '{\n  "context_servers": {\n    "files": { "source": "custom", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }\n  }\n}',
  },
  {
    label: 'OpenCode',
    text: '{\n  "mcp": {\n    "files": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "environment": { "DEBUG": "1" } }\n  }\n}',
  },
  {
    label: 'Gemini CLI',
    text: '{\n  "mcpServers": {\n    "context7": { "httpUrl": "https://mcp.context7.com/mcp" }\n  }\n}',
  },
  {
    label: '裸 map',
    text: '{\n  "context7": { "url": "https://mcp.context7.com/mcp" },\n  "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }\n}',
  },
  {
    label: 'JSONC',
    text: '{\n  // 注释与尾逗号也认\n  "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" }, },\n}',
  },
];

/** 预览里「能导入的一条」：`action` 只区分新增与覆盖，「跳过」由预览逐行切 */
export interface McpImportEntry {
  name: string;
  server: McpServer;
  action: 'add' | 'overwrite';
  /** `action === 'overwrite'` 时给被覆盖的那一条：预览要点名「将覆盖已有的哪一台」 */
  existing?: McpServer;
  /** 这一条被丢掉的字段（未知字段 + 跨传输字段 + 类型不对的键），预览逐行点名 */
  droppedFields: string[];
  /** 不是「丢字段」但值得提前说的（sse→http、command 数组拆分、!cmd 等） */
  notes: string[];
  /** 名字是猜的：预览里给输入框让用户改（map 的键名与显式 name 不改） */
  renamable: boolean;
  /** 名字是猜的（没有显式 name）：界面可以提示「可改」 */
  nameGuessed: boolean;
  style: McpImportStyle;
}

/** 预览里「不导入的一条」：`reason` 是可直接展示的中文原因（其余条目照常导入） */
export interface McpImportRejection {
  name: string;
  reason: string;
  transport?: McpTransport;
  droppedFields: string[];
  notes: string[];
}

/** 整份级别的失败：超限 / 语法错 / 无法识别。有它时 `entries` 与 `rejected` 都是空的 */
export interface McpImportError {
  message: string;
  /** 「无法识别」时给实际看到的顶层键：用户要照着它自己判断贴错了哪一层 */
  topLevelKeys?: string[];
}

export interface McpImportResult {
  error?: McpImportError;
  /** 识别到的信封形状；失败时也可能给出（例如「信封里没有条目」） */
  style?: McpImportStyle;
  entries: McpImportEntry[];
  rejected: McpImportRejection[];
  /** 整份级别被丢掉的字段（信封的兄弟键，如 VS Code 的 `inputs`） */
  droppedFields: string[];
}

/** 空结果：给失败分支用，省得每处都写一遍三个空数组 */
function emptyResult(style?: McpImportStyle): McpImportResult {
  return { entries: [], rejected: [], droppedFields: [], ...(style === undefined ? {} : { style }) };
}

function fail(message: string, options: { style?: McpImportStyle; topLevelKeys?: string[] } = {}): McpImportResult {
  return {
    ...emptyResult(options.style),
    error: { message, ...(options.topLevelKeys === undefined ? {} : { topLevelKeys: options.topLevelKeys }) },
  };
}

/** 是不是一个「普通对象」（数组与 null 都不算） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按**字节**算长度（不是字符数）：上限写的是 256 KB，而一个汉字算 3 字节 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/* ------------------------------------------------------------------ */
/* JSONC 剥离                                                          */
/* ------------------------------------------------------------------ */

/**
 * 剥掉 JSONC 的注释与尾逗号，返回仍是合法 JSON 的文本。
 *
 * 怎么做到「不误伤字符串」：逐字符扫描并**跟踪字符串状态**——遇到 `"` 就整段拷到收尾引号
 * （含 `\"` 转义），字符串内部的 `//`、`/*`、`,` 一律当普通字符。这是本文件最要紧的一条：
 * `"url": "http://localhost:8080/mcp"` 被当成注释吞掉之后，`JSON.parse` 会报一个
 * 与真正原因毫无关系的位置，用户只会以为自己贴错了。
 *
 * 两条已知的「不宽容」（宁可早报也不硬转）：
 *   · 单引号串 / 无引号键不是 JSONC 的合法子集，遇到就抛**带行号的中文**；
 *   · 块注释里换行会被保留（只为让报错行号与原文本对齐）。
 *
 * 尾逗号用「攒着不落笔」的办法剥：逗号先记在心里，下一个有意义的字符若是 `}` / `]` 就丢掉它
 * —— 这样 `[1, 2,]` 与 `{"a": 1,}` 都成立，而 `[1,,2]` 这类真正的语法错仍会被拦下（见下）。
 */
export function stripJsonComments(text: string): string {
  // BOM 不是 JSON 的一部分：不剥掉的话 JSON.parse 会报在第 1 行第 1 列，看起来像文本坏了
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[] = [];
  /** 容器栈：用来判「这个位置期待的是不是一个对象的键」（无引号键的判据） */
  const stack: Array<'obj' | 'arr'> = [];
  let expectKey = false;
  let pendingComma = false;
  let pendingCommaLine = 0;
  let line = 1;
  let index = 0;

  /** 落一个「有意义的字符」：先把攒着的逗号写下去（走到这里说明逗号后面还有元素） */
  const emit = (piece: string): void => {
    if (pendingComma) {
      out.push(',');
      pendingComma = false;
    }
    out.push(piece);
  };

  while (index < source.length) {
    const char = source[index] as string;

    // 字符串字面量：整段原样拷贝，内部的注释符号与逗号都不是语法
    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        const current = source[end] as string;
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '"') break;
        if (current === '\n') line += 1;
        end += 1;
      }
      if (end >= source.length) throw new Error(`第 ${line} 行：字符串没有闭合，检查贴入的内容是否被截断`);
      emit(source.slice(index, end + 1));
      index = end + 1;
      expectKey = false;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error(`第 ${line} 行：块注释没有闭合（缺少 */）`);
      const comment = source.slice(index, end);
      // 换行要留下：报错行号按剥离后的文本算，吃掉换行会让行号整体上移
      for (const inner of comment) if (inner === '\n') out.push('\n');
      line += countNewlines(comment);
      index = end + 2;
      continue;
    }

    if (char === ',') {
      // 连续两个逗号（`[1,,2]`）是真正的语法错：不合并成一个，直接报出来
      if (pendingComma) throw new Error(`第 ${line} 行：多余的逗号（第 ${pendingCommaLine} 行的逗号后面又跟了一个）`);
      pendingComma = true;
      pendingCommaLine = line;
      expectKey = stack[stack.length - 1] === 'obj';
      index += 1;
      continue;
    }
    if (char === '{') {
      emit(char);
      stack.push('obj');
      expectKey = true;
      index += 1;
      continue;
    }
    if (char === '[') {
      emit(char);
      stack.push('arr');
      expectKey = false;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      // 走到收尾符说明攒着的那个逗号是尾逗号：丢掉它（这一步就是「剥尾逗号」本身）
      pendingComma = false;
      out.push(char);
      stack.pop();
      expectKey = false;
      index += 1;
      continue;
    }
    if (char === '\'') {
      throw new Error(`第 ${line} 行：不支持单引号字符串，JSON 的键与值必须用双引号`);
    }
    if (expectKey && /[A-Za-z_$]/.test(char)) {
      throw new Error(`第 ${line} 行：不支持无引号键，键必须用双引号包起来（如 "command"）`);
    }
    if (char === '\n') line += 1;
    // 空白原样落下（**不许**在这里 flush 攒着的逗号，否则 `[1, ]` 的尾逗号就漏掉了）；
    // 其余字符（数字 / true / null / 冒号 …）原样落，真正的语法错留给 JSON.parse
    if (/\s/.test(char)) out.push(char);
    else emit(char);
    index += 1;
  }

  if (pendingComma) out.push(',');
  return out.join('');
}

/** 数一段文本里有几个换行：块注释整段吞掉时用它补行号 */
function countNewlines(text: string): number {
  let total = 0;
  for (const char of text) if (char === '\n') total += 1;
  return total;
}

/** 把 `JSON.parse` 的失败折成**含行号与出错片段**的中文原因 */
function describeJsonFailure(source: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(raw);
  if (position === null) return '贴入的内容不是合法 JSON：请检查括号、引号与逗号是否配对';
  const at = Number(position[1]);
  const before = source.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  const fragment = source.slice(Math.max(0, at - 20), at + 20).replace(/\n/g, '⏎');
  return `贴入的内容不是合法 JSON：第 ${line} 行第 ${column} 列附近「${fragment}」`;
}

/* ------------------------------------------------------------------ */
/* 形状判别                                                            */
/* ------------------------------------------------------------------ */

interface Envelope {
  key: string;
  style: McpImportStyle;
}

/**
 * 认得的信封。顺序就是优先级：同一份 JSON 里同时出现多个信封时，取第一个并在预览里点名
 * 其余作为「整份丢弃的兄弟键」。
 */
const ENVELOPES: readonly Envelope[] = [
  { key: 'mcpServers', style: 'mcpServers' },
  { key: 'servers', style: 'servers' },
  { key: 'context_servers', style: 'context_servers' },
  { key: 'mcp_servers', style: 'mcp_servers' },
  { key: 'mcp', style: 'mcp' },
  { key: 'amp.mcpServers', style: 'amp' },
];

/** URL 字段的别名，按「越明确越优先」排：`httpUrl` 是 Gemini 的 streamable HTTP，优先于 `url` */
const URL_KEYS = [
  'httpUrl',
  'httpURL',
  'http_url',
  'serverUrl',
  'serverURL',
  'server_url',
  'endpoint',
  'baseUrl',
  'baseURL',
  'base_url',
  'url',
] as const;

/** env 字段的别名 */
const ENV_KEYS = ['env', 'envs', 'environment', 'envVars', 'environmentVariables', 'environment_variables'] as const;

/** headers 字段的别名 */
const HEADER_KEYS = ['headers', 'http_headers', 'httpHeaders', 'requestHeaders', 'request_headers'] as const;

/** 名字字段的别名（数组 / 单台条目里用；map 形状用键名） */
const NAME_KEYS = ['name', 'id', 'label', 'title'] as const;

const DECLARED_TRANSPORT_KEYS = ['type', 'transport', 'kind'] as const;

function findEnvelope(root: Record<string, unknown>): Envelope | undefined {
  for (const envelope of ENVELOPES) {
    const value = root[envelope.key];
    if (value !== undefined && (isRecord(value) || Array.isArray(value))) return envelope;
  }
  return undefined;
}

/** 一个对象看起来是不是「一台服务器」：有 command/cmd、url 别名或传输声明 */
function looksLikeServer(raw: Record<string, unknown>): boolean {
  const command = raw.command ?? raw.cmd;
  if (typeof command === 'string' || Array.isArray(command)) return true;
  for (const key of URL_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  for (const key of DECLARED_TRANSPORT_KEYS) if (typeof raw[key] === 'string') return true;
  if ('command' in raw || 'cmd' in raw) return true;
  if ('args' in raw || 'arguments' in raw) return true;
  for (const key of ENV_KEYS) if (key in raw) return true;
  for (const key of HEADER_KEYS) if (key in raw) return true;
  return false;
}

/** 一个对象是不是「一堆服务器」：值全是对象，且至少有一个像服务器 */
function looksLikeServerMap(raw: Record<string, unknown>): boolean {
  const values = Object.values(raw);
  return values.length > 0 && values.every(isRecord) && values.some(looksLikeServer);
}

/** `mcp: { servers: ... }` 这类多包一层的写法：只解一层，且必须看起来确实是服务器容器 */
function unwrapNestedEnvelope(value: Record<string, unknown>): Envelope | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  if (key === undefined) return undefined;
  const envelope = ENVELOPES.find((item) => item.key === key);
  if (!envelope) return undefined;
  const inner = value[key];
  if (Array.isArray(inner)) return envelope;
  if (isRecord(inner) && (Object.keys(inner).length === 0 || looksLikeServerMap(inner))) return envelope;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

interface ParseContext {
  /** 现有配置：只影响每条的 `action` / `existing`，不影响解析结果本身 */
  existing: Map<string, McpServer>;
  /** 本批已经用掉的名字：数组条目里重名要逐条拒，自动名要加后缀 */
  batchNames: Set<string>;
}

/**
 * 剥离 → `JSON.parse` → 形状判别 → 逐条方言归一。
 *
 * `existing` 是「现在设置页里有哪些」：它只影响每条的 `action`（同名 ⇒ 覆盖）与 `existing` 那一格。
 */
export function parseMcpImport(text: string, existing: readonly McpServer[] = []): McpImportResult {
  if (text.trim() === '') return fail('还没有贴入内容');

  // 上限先于一切：10 MB 的贴入先去解析的话，用户看到的是「界面卡住」而不是「太大了」
  if (byteLength(text) > MCP_IMPORT_MAX_BYTES) {
    return fail(`贴入的内容超过 ${MCP_IMPORT_MAX_BYTES / 1024} KB 的上限，请分几次导入`);
  }

  let stripped: string;
  try {
    stripped = stripJsonComments(text);
  } catch (error) {
    // 单引号串 / 无引号键 / 注释没闭合 / 多余逗号：剥离器给的就是带行号的中文原因，原样透出
    return fail(error instanceof Error ? error.message : String(error));
  }

  let root: unknown;
  try {
    root = JSON.parse(stripped);
  } catch (error) {
    return fail(describeJsonFailure(stripped, error));
  }

  const context: ParseContext = {
    existing: new Map(existing.map((server) => [server.name, server])),
    batchNames: new Set<string>(),
  };

  if (Array.isArray(root)) return collectArray(root, 'array', [], context);
  if (isRecord(root)) return collectRecord(root, context);

  return fail(`顶层既不是对象也不是数组（是 ${describeValue(root)}）：请贴一份 MCP 配置`);
}

function collectRecord(root: Record<string, unknown>, context: ParseContext): McpImportResult {
  const envelope = findEnvelope(root);
  if (envelope !== undefined) {
    const siblings = Object.keys(root).filter((key) => key !== envelope.key);
    return collectEnvelope(root[envelope.key], envelope.style, siblings, context);
  }

  // 顶层自己就是一台（裸单项）：名字按内容猜，预览里可改
  if (looksLikeServer(root)) {
    return collectSingle(root, context);
  }

  // 没有信封、也不是单台：如果所有值都是对象且至少一个像服务器，按 name-keyed map 认
  if (looksLikeServerMap(root)) {
    return collectMap(root, 'map', [], context);
  }

  const topLevelKeys = Object.keys(root);
  const seen = topLevelKeys.length === 0 ? '顶层是空对象' : `看到的顶层键：${topLevelKeys.join('、')}`;
  return fail(
    `无法识别这段内容（${seen}）：没有 mcpServers / servers / context_servers / mcp 信封，也没有 command / url`,
    { topLevelKeys },
  );
}

function collectEnvelope(
  value: unknown,
  style: McpImportStyle,
  droppedFields: string[],
  context: ParseContext,
): McpImportResult {
  if (Array.isArray(value)) return collectArray(value, style, droppedFields, context);
  if (isRecord(value)) {
    // `{ "mcp": { "servers": {...} } }`：多包一层时解一层，避免把 `servers` 当成一台服务器
    const nested = unwrapNestedEnvelope(value);
    if (nested !== undefined) {
      const inner = value[nested.key];
      const innerSiblings = Object.keys(value).filter((key) => key !== nested.key);
      return collectEnvelope(inner, nested.style, [...droppedFields, ...innerSiblings], context);
    }
    return collectMap(value, style, droppedFields, context);
  }
  return fail(`${MCP_IMPORT_STYLE_LABELS[style]} 的值既不是对象也不是数组`, { style });
}

function collectArray(
  items: unknown[],
  style: McpImportStyle,
  droppedFields: string[],
  context: ParseContext,
): McpImportResult {
  if (items.length === 0) return fail('数组里没有 MCP 服务器', { style });
  if (items.length > MCP_IMPORT_MAX_ENTRIES) {
    return fail(`这次贴入有 ${items.length} 台服务器，超过 ${MCP_IMPORT_MAX_ENTRIES} 条的上限，请分几次导入`, { style });
  }

  const result: McpImportResult = { ...emptyResult(style), droppedFields: [...droppedFields] };
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      result.rejected.push({
        name: `第 ${index + 1} 项`,
        reason: `这一项不是一个对象（是 ${describeValue(item)}）`,
        droppedFields: [],
        notes: [],
      });
      return;
    }

    const explicitName = readExplicitName(item);
    let name: string;
    let nameGuessed = false;
    if (explicitName !== undefined) {
      name = explicitName;
      if (context.batchNames.has(name)) {
        result.rejected.push({
          name,
          reason: `名字「${name}」与本次导入的前面某一台重名，请改名或删除其中一条`,
          droppedFields: [],
          notes: [],
        });
        return;
      }
    } else {
      name = uniqueName(guessMcpName(item), context.batchNames);
      nameGuessed = true;
    }

    const outcome = parseEntry(item, name, style, nameGuessed, context);
    if (outcome.entry !== undefined) {
      result.entries.push(outcome.entry);
      // 只有真的能导入的条目才占名字：前面一条被拒时，后面同名的那条仍然有机会
      context.batchNames.add(name);
    } else {
      result.rejected.push(outcome.rejection);
    }
  });
  return result;
}

function collectMap(
  container: Record<string, unknown>,
  style: McpImportStyle,
  droppedFields: string[],
  context: ParseContext,
): McpImportResult {
  const names = Object.keys(container);
  if (names.length === 0) return fail('信封里没有 MCP 服务器', { style });
  if (names.length > MCP_IMPORT_MAX_ENTRIES) {
    return fail(`这次贴入有 ${names.length} 台服务器，超过 ${MCP_IMPORT_MAX_ENTRIES} 条的上限，请分几次导入`, { style });
  }

  const result: McpImportResult = { ...emptyResult(style), droppedFields: [...droppedFields] };
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === '') {
      result.rejected.push({
        name: rawName,
        reason: '名字不能为空',
        droppedFields: [],
        notes: [],
      });
      continue;
    }
    if (context.batchNames.has(name)) {
      result.rejected.push({
        name,
        reason: `名字「${name}」与本次导入的前面某一台重名，请改名或删除其中一条`,
        droppedFields: [],
        notes: [],
      });
      continue;
    }
    context.batchNames.add(name);

    const outcome = parseEntry(container[rawName], name, style, false, context);
    if (outcome.entry !== undefined) result.entries.push(outcome.entry);
    else result.rejected.push(outcome.rejection);
  }
  return result;
}

function collectSingle(root: Record<string, unknown>, context: ParseContext): McpImportResult {
  const explicitName = readExplicitName(root);
  const name = explicitName ?? uniqueName(guessMcpName(root), context.batchNames);
  const nameGuessed = explicitName === undefined;
  context.batchNames.add(name);
  const outcome = parseEntry(root, name, 'single', nameGuessed, context);
  return {
    ...emptyResult('single'),
    ...(outcome.entry === undefined ? { rejected: [outcome.rejection] } : { entries: [outcome.entry] }),
  };
}

/* ------------------------------------------------------------------ */
/* 单条方言归一                                                        */
/* ------------------------------------------------------------------ */

type EntryOutcome =
  | { entry: McpImportEntry; rejection?: undefined }
  | { entry?: undefined; rejection: McpImportRejection };

function parseEntry(
  raw: unknown,
  name: string,
  style: McpImportStyle,
  nameGuessed: boolean,
  context: ParseContext,
): EntryOutcome {
  const dropped = new Set<string>();
  const notes: string[] = [];
  const note = (message: string): void => {
    if (!notes.includes(message)) notes.push(message);
  };
  const drop = (field: string): void => {
    dropped.add(field);
  };

  if (!isRecord(raw)) {
    return failed(name, `这一条不是一个 MCP 服务器（值是 ${describeValue(raw)}）`, undefined, dropped, notes);
  }

  const declaredName = readExplicitName(raw);
  if (declaredName !== undefined && declaredName !== name) {
    note(`条目内的名字「${declaredName}」与键名不一致，以「${name}」导入`);
  }

  const declared = readDeclaredTransport(raw, note);
  if (declared.kind === 'unsupported') {
    return failed(name, declared.reason, undefined, dropped, notes);
  }

  // 先判传输，只读**这一支**的字段：跨传输的字段交给下面的「丢掉并点名」，
  // 免得 preview 里出现「command 数组已拆分」这种针对一个根本不会落盘的字段的提示。
  const rawCommand = raw.command ?? raw.cmd;
  const rawHasCommand = typeof rawCommand === 'string' || Array.isArray(rawCommand);
  const rawHasUrl = URL_KEYS.some((key) => typeof raw[key] === 'string' && (raw[key] as string).trim() !== '');

  let transport: McpTransport;
  if (declared.kind !== 'none') {
    transport = declared.kind;
  } else if (rawHasCommand && rawHasUrl) {
    return failed(
      name,
      '同时带了 url 与 command 却没说 type / transport，分不出是 stdio 还是 http',
      undefined,
      dropped,
      notes,
    );
  } else if (rawHasUrl) {
    transport = 'http';
  } else if (rawHasCommand) {
    transport = 'stdio';
  } else {
    return failed(name, '既没有 url 也没有 command，不是一台 MCP 服务器', undefined, dropped, notes);
  }

  const command = transport === 'stdio' ? readCommand(raw, dropped, note) : { args: [] };
  const url = transport === 'http' ? readUrl(raw, dropped, note) : {};
  const env = transport === 'stdio' ? readStringMap(raw, 'env', ENV_KEYS, dropped, note) : { value: {} };
  const headers = transport === 'http' ? readStringMap(raw, 'headers', HEADER_KEYS, dropped, note) : { value: {} };
  const enabled = readEnabled(raw, dropped, note);
  if (!enabled.value) note('源配置标记为停用（enabled: false），导入后可在表格里再启用');

  // 声明与字段对不上时拒绝而不是补齐：落盘之后会以一个空端点出现在厂商配置里
  if (transport === 'http' && url.value === undefined) {
    return failed(name, '声明了 http，但缺少 url', transport, dropped, notes);
  }
  if (transport === 'stdio' && command.value === undefined) {
    return failed(name, '声明了 stdio，但缺少 command', transport, dropped, notes);
  }

  // 跨传输字段按「不认识」处置：stdio 里的 url / headers、http 里的 command / args / env
  if (transport === 'stdio') {
    for (const key of URL_KEYS) if (key in raw) drop(key);
    for (const key of HEADER_KEYS) if (key in raw) drop(key);
  } else {
    for (const key of ['command', 'cmd', 'args', 'arguments'] as const) if (key in raw) drop(key);
    for (const key of ENV_KEYS) if (key in raw) drop(key);
  }

  // 占位检查：url / command / args 里一个都不认；env / headers 的值里只认 ${ENV_NAME}
  const placeholders: Array<{ text: string; allowEnvName: boolean; where: string }> = [];
  if (transport === 'http') {
    placeholders.push({ text: url.value as string, allowEnvName: false, where: 'url' });
    for (const [key, text] of Object.entries(headers.value)) placeholders.push({ text, allowEnvName: true, where: `headers.${key}` });
  } else {
    placeholders.push({ text: command.value as string, allowEnvName: false, where: 'command' });
    command.args.forEach((text, index) => placeholders.push({ text, allowEnvName: false, where: `args[${index}]` }));
    for (const [key, text] of Object.entries(env.value)) placeholders.push({ text, allowEnvName: true, where: `env.${key}` });
  }
  for (const item of placeholders) {
    const bad = findUnsupportedPlaceholder(item.text, item.allowEnvName);
    if (bad !== null) {
      return failed(
        name,
        `不支持占位 ${bad}（在 ${item.where}）：占位只能写在 env / headers 的值里，且只认 \${环境变量名} 这一种形式`,
        transport,
        dropped,
        notes,
      );
    }
    if (item.allowEnvName && item.text.trimStart().startsWith('!')) {
      note(`${item.where} 含 ! 命令写法：启动 MCP 时会被执行，确认来源可信`);
    }
  }

  // 其余字段（cwd / timeout / alwaysAllow / source / inputs…）一律「丢掉并点名」
  const consumed = consumedKeys(raw, transport, declaredName);
  for (const key of Object.keys(raw)) {
    if (!consumed.has(key)) drop(key);
  }

  const enabledValue = enabled.value;
  const server: McpServer =
    transport === 'http'
      ? {
        name,
        transport,
        url: url.value as string,
        args: [],
        env: {},
        headers: headers.value,
        enabled: enabledValue,
      }
      : {
        name,
        transport,
        command: command.value as string,
        args: command.args,
        env: env.value,
        headers: {},
        enabled: enabledValue,
      };

  // 最后一道形状闸：解析器的归一结果必须能过契约
  const parsed = McpServerSchema.safeParse(server);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failed(name, `归一后的配置不合法：${issue?.message ?? '未知原因'}`, transport, dropped, notes);
  }

  const previous = context.existing.get(name);
  const entry: McpImportEntry = {
    name,
    server: parsed.data,
    action: previous === undefined ? 'add' : 'overwrite',
    ...(previous === undefined ? {} : { existing: previous }),
    droppedFields: [...dropped],
    notes,
    renamable: nameGuessed,
    nameGuessed,
    style,
  };
  return { entry };
}

function failed(
  name: string,
  reason: string,
  transport: McpTransport | undefined,
  dropped: Set<string>,
  notes: string[],
): EntryOutcome {
  return { rejection: rejection(name, reason, transport, dropped, notes) };
}

function rejection(
  name: string,
  reason: string,
  transport: McpTransport | undefined,
  dropped: Set<string>,
  notes: string[],
): McpImportRejection {
  return {
    name,
    reason,
    ...(transport === undefined ? {} : { transport }),
    droppedFields: [...dropped],
    notes,
  };
}

/** 已被解析器消费的键：其余键进「被丢字段」 */
function consumedKeys(raw: Record<string, unknown>, transport: McpTransport, declaredName?: string): Set<string> {
  const consumed = new Set<string>([
    ...DECLARED_TRANSPORT_KEYS,
    'enabled',
    'disabled',
  ]);
  // 只把实际用到的名字键算作消费；没用到的（比如同时写了 name 与 id）留给「被丢字段」点名
  if (declaredName !== undefined) {
    for (const key of NAME_KEYS) {
      if (raw[key] === declaredName) consumed.add(key);
    }
  }
  if (transport === 'stdio') {
    for (const key of ['command', 'cmd', 'args', 'arguments'] as const) consumed.add(key);
    for (const key of ENV_KEYS) consumed.add(key);
  } else {
    for (const key of URL_KEYS) consumed.add(key);
    for (const key of HEADER_KEYS) consumed.add(key);
  }
  return consumed;
}

/* ------------------------------------------------------------------ */
/* 字段读取                                                            */
/* ------------------------------------------------------------------ */

/** `type` / `transport` / `kind` 的读数：http / stdio / 不认识 / 没给 */
type DeclaredTransport =
  | { kind: 'http' | 'stdio' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'none' };

/**
 * 读声明的传输。`type` 优先于 `transport`（VS Code / Cursor 用前者，本应用落盘用后者），
 * 两者同时出现且打架时以 `type` 为准并留一条 note。`sse` 是**看得出来**的构造：
 * pi 的 MCP 客户端只认 streamable HTTP，旧 SSE 端点按 http 导入并在预览里提前说不兼容。
 */
function readDeclaredTransport(raw: Record<string, unknown>, note: (message: string) => void): DeclaredTransport {
  const declared = DECLARED_TRANSPORT_KEYS
    .map((key) => ({ key, value: raw[key] }))
    .filter((item) => item.value !== undefined);
  if (declared.length === 0) return { kind: 'none' };

  const first = declared[0];
  if (first === undefined) return { kind: 'none' };
  if (typeof first.value !== 'string') return { kind: 'unsupported', reason: `${first.key} 只能是字符串` };
  if (declared.length > 1) {
    const values = new Set(declared.map((item) => String(item.value).toLowerCase()));
    if (values.size > 1) note('type / transport / kind 同时存在且不一致，以第一个为准');
  }

  const value = first.value.trim().toLowerCase().replace(/_/g, '-');
  if (value === 'stdio' || value === 'local' || value === 'command') return { kind: 'stdio' };
  if (value === 'http' || value === 'streamable-http' || value === 'streamablehttp' || value === 'remote') {
    return { kind: 'http' };
  }
  if (value === 'sse') {
    note('源配置是 sse：已按 http 导入，旧版 SSE 端点可能不兼容');
    return { kind: 'http' };
  }
  if (value === 'sdk' || value === 'in-process' || value === 'inprocess') {
    return { kind: 'unsupported', reason: `暂不支持 ${first.key}: '${first.value}'（进程内 SDK 传输）` };
  }
  return { kind: 'unsupported', reason: `不认识的传输类型「${first.value}」：只认 stdio 与 http / streamable-http` };
}

interface CommandRead {
  value?: string;
  args: string[];
}

/** 读 command / cmd 与 args / arguments：支持字符串、命令数组（OpenCode）与空格分隔的 args 字符串 */
function readCommand(raw: Record<string, unknown>, dropped: Set<string>, note: (message: string) => void): CommandRead {
  let value: string | undefined;
  let args: string[] = [];

  const commandValue = raw.command ?? raw.cmd;
  if (commandValue !== undefined) {
    if (typeof commandValue === 'string') {
      value = commandValue.trim() || undefined;
    } else if (Array.isArray(commandValue)) {
      const parts = commandValue
        .filter((item): item is string | number | boolean => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
        .map((item) => String(item));
      if (parts.length > 0) {
        value = parts[0]?.trim() || undefined;
        args = parts.slice(1);
        note('command 数组已拆成 command + args');
      }
      if (parts.length !== commandValue.length) dropped.add('command');
    } else {
      dropped.add('command');
    }
  }
  if (raw.command !== undefined && raw.cmd !== undefined && JSON.stringify(raw.command) !== JSON.stringify(raw.cmd)) {
    note('command 与 cmd 同时存在且不一致，以 command 为准');
  }

  // args 与 arguments 是两个阵营的习惯写法：同时出现时合并，而不是只认第一个
  for (const key of ['args', 'arguments'] as const) {
    const argsValue = raw[key];
    if (argsValue === undefined) continue;
    if (Array.isArray(argsValue)) {
      argsValue.forEach((item, index) => {
        if (typeof item === 'string') args.push(item);
        else if (typeof item === 'number' || typeof item === 'boolean') {
          args.push(String(item));
          note(`${key}[${index}] 已转为字符串`);
        } else {
          dropped.add(`${key}[${index}]`);
        }
      });
    } else if (typeof argsValue === 'string') {
      args.push(...splitShellArgs(argsValue));
      note(`${key} 字符串已按空格拆分`);
    } else {
      dropped.add(key);
    }
  }
  if (raw.args !== undefined && raw.arguments !== undefined) note('args 与 arguments 同时存在，已合并');

  return { ...(value === undefined ? {} : { value }), args };
}

interface UrlRead {
  value?: string;
}

/** 读 url 别名：httpUrl 优先（Gemini 的 streamable HTTP），其余按声明的优先级回落 */
function readUrl(raw: Record<string, unknown>, dropped: Set<string>, note: (message: string) => void): UrlRead {
  const found: Array<{ key: string; value: string }> = [];
  for (const key of URL_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      dropped.add(key);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      dropped.add(key);
      continue;
    }
    found.push({ key, value: trimmed });
  }
  if (found.length === 0) return {};
  const first = found[0];
  if (first === undefined) return {};
  if (found.length > 1 && new Set(found.map((item) => item.value)).size > 1) {
    note(`同时存在多个 url 字段，以 ${first.key} 为准`);
  }
  return { value: first.value };
}

/**
 * 读一张「键 → 字符串」表（env / headers）。支持多个别名合并。
 * 键与值都要是字符串；数字 / 布尔值转字符串并留 note，对象 / 数组逐格丢掉并点名。
 */
function readStringMap(
  raw: Record<string, unknown>,
  field: 'env' | 'headers',
  aliases: readonly string[],
  dropped: Set<string>,
  note: (message: string) => void,
): { value: Record<string, string> } {
  const map: Record<string, string> = {};
  let found = 0;
  for (const alias of aliases) {
    if (!(alias in raw)) continue;
    found += 1;
    const value = raw[alias];
    if (!isRecord(value)) {
      dropped.add(alias);
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === '') {
        dropped.add(`${field}.(空键名)`);
        continue;
      }
      if (typeof item === 'string') {
        map[key] = normalizeEnvReference(item, note);
        continue;
      }
      if (typeof item === 'number' || typeof item === 'boolean') {
        map[key] = normalizeEnvReference(String(item), note);
        note(`${field}.${key} 已转为字符串`);
        continue;
      }
      dropped.add(`${field}.${key}`);
    }
  }
  if (found > 1) note(`同时存在多个 ${field} 字段，已合并`);
  return { value: map };
}

function readEnabled(raw: Record<string, unknown>, dropped: Set<string>, note: (message: string) => void): { value: boolean } {
  let value = true;
  const read = (input: unknown): boolean | undefined => {
    if (typeof input === 'boolean') return input;
    if (input === 1 || input === '1' || input === 'true') return true;
    if (input === 0 || input === '0' || input === 'false') return false;
    return undefined;
  };

  if (raw.enabled !== undefined) {
    const parsed = read(raw.enabled);
    if (parsed === undefined) dropped.add('enabled');
    else value = parsed;
  }
  if (raw.disabled !== undefined) {
    const parsed = read(raw.disabled);
    if (parsed === undefined) dropped.add('disabled');
    else if (raw.enabled !== undefined) note('enabled 与 disabled 同时存在，以 enabled 为准');
    else value = !parsed;
  }
  return { value };
}

/* ------------------------------------------------------------------ */
/* 名字与占位                                                          */
/* ------------------------------------------------------------------ */

/** 从 URL 里取一个像名字的标签：`mcp.context7.com` ⇒ `context7`（前导的 mcp / api / www 是噪音） */
function hostLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length > 1 && ['mcp', 'api', 'www'].includes(labels[0] as string)) labels.shift();
  return labels[0] ?? '';
}

/** 通用包名段：`@playwright/mcp` 的末段是 `mcp`，光叫「mcp」当名字等于没起名 ⇒ 回落用作用域名 */
const GENERIC_PACKAGE_SEGMENTS = new Set(['mcp', 'server', 'cli', 'index', 'main']);

/** 从参数里找包名：`["-y", "@playwright/mcp@latest"]` ⇒ `playwright`（跳过选项、去掉版本号） */
function packageLabel(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith('-')) {
      // `uvx --from mcp-server-git git-mcp`：`mcp-server-git` 是选项的值，不是要起的命令；
      // 把值当包名用，猜出来的名字就会是 `from` 的下一个词，跟用户看到的完全对不上。
      if (optionTakesValue(arg)) index += 1;
      continue;
    }
    const parts = arg.replace(/@[^@/]*$/, '').split('/').filter((part) => part !== '' && part !== '@');
    const last = parts[parts.length - 1] ?? '';
    if (last === '') continue;
    if (GENERIC_PACKAGE_SEGMENTS.has(last.toLowerCase()) && parts.length > 1) {
      return (parts[0] as string).replace(/^@/, '');
    }
    let name = last;
    // `mcp-server-fetch` / `mcp_server_fetch` / `server-filesystem` ⇒ `fetch` / `fetch` / `filesystem`
    while (/^(mcp|server)[-_]/i.test(name) && name.replace(/^(mcp|server)[-_]/i, '') !== '') {
      name = name.replace(/^(mcp|server)[-_]/i, '');
    }
    return name;
  }
  return '';
}

/** 把一串自由文本净化为合法的自动名：小写 → 非法字符转 `-` → 折叠 → 去首尾 → 截 32 位 */
export function sanitizeMcpName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'server' : cleaned;
}

/** 给没有名字的条目猜一个默认名：显式 name → URL 主机名 → 参数里的包名 → 命令 basename */
export function guessMcpName(raw: Record<string, unknown>): string {
  const explicit = readExplicitName(raw);
  if (explicit !== undefined) return sanitizeMcpName(explicit);
  for (const key of URL_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') continue;
    const label = hostLabel(value);
    if (label !== '') return sanitizeMcpName(label);
  }
  const argsValue = raw.args ?? raw.arguments;
  const args = Array.isArray(argsValue)
    ? argsValue.filter((item): item is string => typeof item === 'string')
    : typeof argsValue === 'string'
      ? splitShellArgs(argsValue)
      : [];
  const fromPackage = packageLabel(args);
  if (fromPackage !== '') return sanitizeMcpName(fromPackage);
  const commandValue = raw.command ?? raw.cmd;
  if (typeof commandValue === 'string' && commandValue !== '') {
    return sanitizeMcpName(commandValue.split(/[\\/]/).pop() ?? commandValue);
  }
  if (Array.isArray(commandValue) && typeof commandValue[0] === 'string') {
    return sanitizeMcpName(commandValue[0].split(/[\\/]/).pop() ?? commandValue[0]);
  }
  return sanitizeMcpName('');
}

/** 本批内去重：`context7` → `context7-2` → `context7-3` */
function uniqueName(base: string, taken: Set<string>): string {
  const root = base.slice(0, 28);
  let candidate = base;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${root}-${index}`;
    index += 1;
  }
  return candidate;
}

function readExplicitName(raw: Record<string, unknown>): string | undefined {
  for (const key of NAME_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * 预览里那一格名字能不能导入：`null` = 可以，非空 = 中文原因（这一行**不许导入**）。
 * 「撞名」比的是**去掉首尾空白后的原文**：本应用落盘就是按这个字符串做键的。
 */
export function mcpImportNameIssue(name: string, taken: readonly string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return '名字不能为空：请给这一台填一个名字';
  if (taken.some((other) => other.trim() === trimmed)) {
    return `名字「${trimmed}」与本次导入的另一台重名，请改一个`;
  }
  return null;
}

/** `${env:NAME}` 是 VS Code / 部分客户端的写法；本应用只认 `${NAME}`，这里做等价转换并留 note */
function normalizeEnvReference(value: string, note: (message: string) => void): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
    note(`已将 \${env:${name}} 转成 \${${name}}`);
    return `\${${name}}`;
  });
}

/**
 * 找出第一个不支持的 `${…}` 占位，返回它的**原文**（拒绝原因里要逐字点出来，用户才改得动）。
 * `allowEnvName` 为 true 时只认 `${ENV_NAME}`（env / headers 的值）；
 * 为 false 时一个都不认（url / command / args：它们不参与注入时的解析）。
 * 只认 `}` 收尾的写法；没闭合的 `${` 也判不支持（它一定是某处被截断了）。
 */
function findUnsupportedPlaceholder(text: string, allowEnvName: boolean): string | null {
  const openings = text.match(/\$\{/g)?.length ?? 0;
  const matches = [...text.matchAll(/\$\{([^}]*)\}/g)];
  // 有 `${` 却没有对应的 `}`：一定是某处被截断了，按不支持处置
  if (matches.length < openings) return '${';
  for (const match of matches) {
    const inner = match[1] ?? '';
    if (allowEnvName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) continue;
    return match[0];
  }
  return null;
}

/** 值的中文描述：拒绝原因里要说清「看到的是什么」 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

/** 空格分隔的 args 字符串 → 数组：支持单/双引号；反斜杠只在转义空白 / 引号时吃掉 */
function splitShellArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;

    // Windows 路径（C:\foo）必须原样保留：只有「反斜杠 + 空白 / 引号」才是转义
    if (char === '\\') {
      const next = input[index + 1];
      if (next !== undefined && (next === '"' || next === "'" || /\s/.test(next))) {
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/* ------------------------------------------------------------------ */
/* 合并语义                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把预览里**决定导入的那些行**并进现有集合，返回一份新的整份列表。
 * 覆盖的条目原地替换（与 `saveMcpServer` 的 upsert 同序），新增按贴入顺序追加。
 * `clearFirst` 为真时从空列表起步 —— 那是用户明确勾选的「先清空现有条目再导入」。
 */
export function applyMcpImport(
  current: readonly McpServer[],
  rows: ReadonlyArray<{ name: string; server: McpServer }>,
  clearFirst = false,
): McpServer[] {
  const next: McpServer[] = clearFirst ? [] : [...current];
  for (const row of rows) {
    const index = next.findIndex((server) => server.name === row.name);
    if (index >= 0) next[index] = row.server;
    else next.push(row.server);
  }
  return next;
}
