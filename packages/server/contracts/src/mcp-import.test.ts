// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { McpServer } from './mcp';
import {
  MCP_IMPORT_MAX_BYTES,
  MCP_IMPORT_SHAPE_EXAMPLES,
  applyMcpImport,
  mcpImportNameIssue,
  parseMcpImport,
  sanitizeMcpName,
  stripJsonComments,
} from './mcp-import';

function server(name: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    headers: {},
    enabled: true,
    ...overrides,
  };
}

function entryOf(text: string) {
  const result = parseMcpImport(text);
  expect(result.error).toBeUndefined();
  expect(result.entries).toHaveLength(1);
  return result.entries[0]!;
}

describe('parseMcpImport：认得的形状', () => {
  it('本应用数组：逐条归一，缺省 args/env/headers/enabled', () => {
    const result = parseMcpImport(JSON.stringify([
      { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://mcp.invalid/mcp' },
    ]));

    expect(result.error).toBeUndefined();
    expect(result.style).toBe('array');
    expect(result.entries.map((entry) => entry.server.transport)).toEqual(['stdio', 'http']);
    expect(result.entries[0]?.server).toMatchObject({
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
      headers: {},
      enabled: true,
    });
    expect(result.entries[1]?.server).toMatchObject({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.invalid/mcp',
      args: [],
      env: {},
      headers: {},
      enabled: true,
    });
  });

  it('Claude / Cursor 的 mcpServers 信封：键名即名字，同名标记覆盖', () => {
    const existing = [server('context7', { transport: 'http', command: undefined, url: 'https://old.invalid/mcp' })];
    const result = parseMcpImport(
      '{ "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }',
      existing,
    );

    expect(result.style).toBe('mcpServers');
    const entry = result.entries[0]!;
    expect(entry.name).toBe('context7');
    expect(entry.action).toBe('overwrite');
    expect(entry.existing?.url).toBe('https://old.invalid/mcp');
    expect(entry.server).toMatchObject({ name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  });

  it('VS Code 的 servers 信封：inputs 作为整份兄弟键被点名丢掉', () => {
    const result = parseMcpImport(
      JSON.stringify({
        servers: {
          playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
        },
        inputs: [{ id: 'token' }],
      }),
    );

    expect(result.style).toBe('servers');
    expect(result.droppedFields).toEqual(['inputs']);
    expect(result.entries[0]?.server).toMatchObject({
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    });
  });

  it('Zed 的 context_servers：source 丢掉，command 推断为 stdio', () => {
    const entry = entryOf(
      JSON.stringify({
        context_servers: {
          files: { source: 'custom', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        },
      }),
    );

    expect(entry.style).toBe('context_servers');
    expect(entry.server.transport).toBe('stdio');
    expect(entry.droppedFields).toContain('source');
  });

  it('OpenCode 的 mcp：type local / command 数组 / environment 别名', () => {
    const entry = entryOf(
      JSON.stringify({
        mcp: {
          files: {
            type: 'local',
            command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            environment: { DEBUG: '1' },
          },
        },
      }),
    );

    expect(entry.style).toBe('mcp');
    expect(entry.server.transport).toBe('stdio');
    expect(entry.server.command).toBe('npx');
    expect(entry.server.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(entry.server.env).toEqual({ DEBUG: '1' });
    expect(entry.notes).toContain('command 数组已拆成 command + args');
  });

  it('Gemini CLI 的 httpUrl 优先于 url', () => {
    const entry = entryOf(
      JSON.stringify({
        mcpServers: {
          gemini: {
            url: 'https://old-sse.invalid/sse',
            httpUrl: 'https://mcp.context7.com/mcp',
            headers: { Authorization: 'Bearer x' },
          },
        },
      }),
    );

    expect(entry.server.transport).toBe('http');
    expect(entry.server.url).toBe('https://mcp.context7.com/mcp');
    expect(entry.server.headers).toEqual({ Authorization: 'Bearer x' });
    expect(entry.notes.some((note) => note.includes('url 字段'))).toBe(true);
  });

  it('没有信封的 name-keyed map 也认', () => {
    const result = parseMcpImport(
      JSON.stringify({
        context7: { url: 'https://mcp.context7.com/mcp' },
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      }),
    );

    expect(result.style).toBe('map');
    expect(result.entries.map((entry) => entry.name)).toEqual(['context7', 'playwright']);
    expect(result.entries.map((entry) => entry.server.transport)).toEqual(['http', 'stdio']);
  });

  it('裸单项：名字按参数里的包名猜，预览里可改', () => {
    const entry = entryOf('{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }');

    expect(entry.style).toBe('single');
    expect(entry.name).toBe('playwright');
    expect(entry.nameGuessed).toBe(true);
    expect(entry.renamable).toBe(true);
  });

  it('{ mcp: { servers: ... } } 多包一层也能解', () => {
    const result = parseMcpImport('{ "mcp": { "servers": { "x": { "command": "npx" } } } }');

    expect(result.error).toBeUndefined();
    expect(result.style).toBe('servers');
    expect(result.entries.map((entry) => entry.name)).toEqual(['x']);
  });

  it('JSONC：注释与尾逗号都认，字符串里的 // 不动', () => {
    const result = parseMcpImport(`{
      // 注释
      "mcpServers": {
        "context7": { "url": "https://mcp.context7.com/mcp" }, /* 块注释 */
      },
    }`);

    expect(result.error).toBeUndefined();
    expect(result.entries[0]?.server.url).toBe('https://mcp.context7.com/mcp');
  });

  it('所有示例按钮自己都能被认出来', () => {
    for (const example of MCP_IMPORT_SHAPE_EXAMPLES) {
      const result = parseMcpImport(example.text);
      expect(result.error, example.label).toBeUndefined();
      expect(result.entries.length, example.label).toBeGreaterThan(0);
    }
  });
});

describe('stripJsonComments', () => {
  it('剥注释与尾逗号，字符串里的 // 与逗号原样保留', () => {
    const text = '{\n  "url": "http://localhost:8080/mcp", // 行尾注释\n  "args": ["a,b", /* 块注释 */ "c",],\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: 'http://localhost:8080/mcp',
      args: ['a,b', 'c'],
    });
  });

  it('BOM 先剥掉', () => {
    expect(stripJsonComments('\uFEFF{"a":1}')).toBe('{"a":1}');
  });

  it('单引号 / 无引号键 / 连续逗号 / 未闭合注释都给带行号的中文原因', () => {
    expect(() => stripJsonComments("{ 'a': 1 }")).toThrowError(/单引号/);
    expect(() => stripJsonComments('{ a: 1 }')).toThrowError(/无引号键/);
    expect(() => stripJsonComments('[1,,2]')).toThrowError(/多余的逗号/);
    expect(() => stripJsonComments('{ /* 没闭合')).toThrowError(/块注释没有闭合/);
  });
});

describe('parseMcpImport：条目化与逐条拒绝', () => {
  it('sse 按 http 导入并留 note；sdk 直接拒', () => {
    const sse = parseMcpImport('{ "mcpServers": { "old": { "type": "sse", "url": "https://old.invalid/sse" } } }');
    expect(sse.entries[0]?.server.transport).toBe('http');
    expect(sse.entries[0]?.notes.some((note) => note.includes('sse'))).toBe(true);

    const sdk = parseMcpImport('{ "mcpServers": { "inner": { "type": "sdk", "command": "npx" } } }');
    expect(sdk.entries).toHaveLength(0);
    expect(sdk.rejected[0]?.reason).toContain('SDK');
  });

  it('声明与字段对不上、同时带 url 与 command、两者都没有：逐条拒绝，不猜', () => {
    const missing = parseMcpImport('{ "mcpServers": { "x": { "type": "stdio" } } }');
    expect(missing.rejected[0]?.reason).toContain('缺少 command');

    const ambiguous = parseMcpImport('{ "mcpServers": { "x": { "command": "npx", "url": "https://x.invalid/mcp" } } }');
    expect(ambiguous.rejected[0]?.reason).toContain('分不出');

    const empty = parseMcpImport('{ "mcpServers": { "x": { "enabled": false } } }');
    expect(empty.rejected[0]?.reason).toContain('既没有 url 也没有 command');
  });

  it('跨传输字段丢掉并点名，但条目照常导入', () => {
    const stdio = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          x: { type: 'stdio', command: 'npx', url: 'https://x.invalid/mcp', headers: { A: 'b' } },
        },
      }),
    );
    expect(stdio.entries).toHaveLength(1);
    expect(stdio.entries[0]?.droppedFields).toEqual(expect.arrayContaining(['url', 'headers']));

    const http = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          x: { type: 'http', url: 'https://x.invalid/mcp', command: 'npx', args: ['-y'], env: { A: 'b' } },
        },
      }),
    );
    expect(http.entries).toHaveLength(1);
    expect(http.entries[0]?.droppedFields).toEqual(expect.arrayContaining(['command', 'args', 'env']));
  });

  it('args 字符串按空白拆分，引号保留空格，Windows 路径的反斜杠不被吃掉', () => {
    const entry = entryOf(
      '{ "mcpServers": { "x": { "command": "npx", "args": "-y \\"@scope/pkg\\" C:\\\\tools\\\\x" } } }',
    );
    expect(entry.server.args).toEqual(['-y', '@scope/pkg', 'C:\\tools\\x']);
    expect(entry.notes).toContain('args 字符串已按空格拆分');
  });

  it('未知字段点名；数字 / 布尔的 env / headers 值转字符串，对象值丢掉', () => {
    const entry = entryOf(
      JSON.stringify({
        mcpServers: {
          x: {
            command: 'npx',
            args: [1, 'two', { bad: true }],
            env: { PORT: 3000, DEBUG: true, BAD: { nested: 1 } },
            cwd: '/tmp',
            timeout: 10,
          },
        },
      }),
    );

    expect(entry.server.args).toEqual(['1', 'two']);
    expect(entry.server.env).toEqual({ PORT: '3000', DEBUG: 'true' });
    expect(entry.droppedFields).toEqual(expect.arrayContaining(['args[2]', 'env.BAD', 'cwd', 'timeout']));
    expect(entry.notes).toContain('args[0] 已转为字符串');
  });

  it('enabled / disabled 都认，enabled 优先', () => {
    const disabled = entryOf('{ "mcpServers": { "x": { "command": "npx", "disabled": true } } }');
    expect(disabled.server.enabled).toBe(false);
    expect(disabled.notes.some((note) => note.includes('停用'))).toBe(true);

    const both = entryOf('{ "mcpServers": { "x": { "command": "npx", "enabled": true, "disabled": true } } }');
    expect(both.server.enabled).toBe(true);
    expect(both.notes.some((note) => note.includes('enabled'))).toBe(true);
  });

  it('占位：env / headers 只认 ${NAME}，command / url / args 一个都不认', () => {
    const ok = entryOf(
      '{ "mcpServers": { "x": { "command": "npx", "env": { "TOKEN": "${TOKEN}" } } } }',
    );
    expect(ok.server.env.TOKEN).toBe('${TOKEN}');

    // `${env:NAME}` 是部分客户端的写法：等价转成 `${NAME}` 并留 note
    const envSyntax = entryOf(
      '{ "mcpServers": { "x": { "command": "npx", "env": { "TOKEN": "${env:TOKEN}" } } } }',
    );
    expect(envSyntax.server.env.TOKEN).toBe('${TOKEN}');
    expect(envSyntax.notes.some((note) => note.includes('${env:TOKEN}'))).toBe(true);

    for (const text of [
      '{ "mcpServers": { "x": { "command": "npx", "env": { "TOKEN": "${input:token}" } } } }',
      '{ "mcpServers": { "x": { "command": "${BIN}" } } }',
      '{ "mcpServers": { "x": { "type": "http", "url": "https://x.invalid/${PATH}" } } }',
      '{ "mcpServers": { "x": { "command": "npx", "args": ["${workspaceFolder}"] } } }',
    ]) {
      const result = parseMcpImport(text);
      expect(result.entries).toHaveLength(0);
      expect(result.rejected[0]?.reason).toContain('占位');
    }
  });

  it('重复的显式名字：后面那条拒绝；自动名则加后缀', () => {
    const duplicate = parseMcpImport(
      JSON.stringify([
        { name: 'x', transport: 'stdio', command: 'npx' },
        { name: 'x', transport: 'stdio', command: 'npx' },
      ]),
    );
    expect(duplicate.entries.map((entry) => entry.name)).toEqual(['x']);
    expect(duplicate.rejected[0]?.reason).toContain('重名');

    const auto = parseMcpImport(
      JSON.stringify([
        { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
        { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      ]),
    );
    expect(auto.entries.map((entry) => entry.name)).toEqual(['playwright', 'playwright-2']);
  });

  it('数组里非对象项逐条拒绝，其余照常导入', () => {
    const result = parseMcpImport(JSON.stringify([1, { name: 'ok', transport: 'stdio', command: 'npx' }]));
    expect(result.entries.map((entry) => entry.name)).toEqual(['ok']);
    expect(result.rejected[0]?.name).toBe('第 1 项');
  });
});

describe('parseMcpImport：整份级失败', () => {
  it('空文本 / 非法 JSON / 认不出的顶层给中文原因', () => {
    expect(parseMcpImport('  ').error?.message).toContain('还没有贴入内容');
    expect(parseMcpImport('{ "mcpServers": ').error?.message).toContain('不是合法 JSON');
    const unknown = parseMcpImport('{ "foo": 1 }');
    expect(unknown.error?.message).toContain('无法识别');
    expect(unknown.error?.topLevelKeys).toEqual(['foo']);
  });

  it('字节上限先于解析；条目数上限在条目化前拦下', () => {
    expect(parseMcpImport('x'.repeat(MCP_IMPORT_MAX_BYTES + 1)).error?.message).toContain('上限');

    const many = Array.from({ length: 101 }, (_, index) => ({ name: `s${index}`, transport: 'stdio', command: 'npx' }));
    expect(parseMcpImport(JSON.stringify(many)).error?.message).toContain('101');
  });

  it('空数组 / 空信封给中文原因', () => {
    expect(parseMcpImport('[]').error?.message).toContain('数组里没有');
    expect(parseMcpImport('{ "mcpServers": {} }').error?.message).toContain('信封里没有');
  });
});

describe('名字与合并', () => {
  it('sanitizeMcpName 幂等且对空串有兜底', () => {
    expect(sanitizeMcpName('My Server!')).toBe('my-server');
    expect(sanitizeMcpName('---')).toBe('server');
    expect(sanitizeMcpName(sanitizeMcpName('My Server!'))).toBe('my-server');
  });

  it('mcpImportNameIssue 拦空名与撞名', () => {
    expect(mcpImportNameIssue('', [])).toContain('不能为空');
    expect(mcpImportNameIssue('x', ['x'])).toContain('重名');
    expect(mcpImportNameIssue('x', ['y'])).toBeNull();
  });

  it('applyMcpImport：覆盖原地替换、新增追加、clearFirst 从空开始', () => {
    const current = [server('a'), server('b')];
    const rows = [
      { name: 'b', server: server('b', { command: 'changed' }) },
      { name: 'c', server: server('c') },
    ];

    const merged = applyMcpImport(current, rows);
    expect(merged.map((item) => item.name)).toEqual(['a', 'b', 'c']);
    expect(merged[1]?.command).toBe('changed');

    const cleared = applyMcpImport(current, rows, true);
    expect(cleared.map((item) => item.name)).toEqual(['b', 'c']);
  });
});

describe('猜名字：uvx / python -m 这类启动器', () => {
  it('uvx 取包名，mcp-/server- 前缀与下划线都剥掉', () => {
    expect(entryOf('{ "command": "uvx", "args": ["mcp-server-fetch"] }').name).toBe('fetch');
    expect(entryOf('{ "command": "uvx", "args": ["mcp_server_time"] }').name).toBe('time');
  });

  it('--from / --python 的取值不当作包名', () => {
    expect(entryOf('{ "command": "uvx", "args": ["--from", "some-index", "mcp-server-git"] }').name).toBe('git');
    expect(
      entryOf('{ "command": "uvx", "args": ["--python", "3.12", "mcp-server-fetch"] }').name,
    ).toBe('fetch');
  });

  it('python3 -m 模块名也走同一套前缀剥离', () => {
    expect(entryOf('{ "command": "python3", "args": ["-m", "mcp_server_fetch"] }').name).toBe('fetch');
  });
});
