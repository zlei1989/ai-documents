import { z } from 'zod';
import { McpServerSchema } from './mcp';

/* ---------------- 供应商 ---------------- */

export const ProtocolSchema = z.enum(['anthropic', 'openai']);
export type Protocol = z.infer<typeof ProtocolSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** 声明模型支持图像输入；未设置按不支持处理 */
  supportsImages: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: ProtocolSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(ModelInfoSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** 下行视图：密钥只出不进 */
export const ProviderViewSchema = ProviderSchema.extend({
  apiKey: z.string(), // 掩码，如 sk-…3a0f
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/* ---------------- MCP ---------------- */

export * from './mcp';
export * from './mcp-import';
export * from './mcp-launcher';

/* ---------------- Skills ---------------- */

export const SkillRefSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  dir: z.string(),
  origin: z.enum(['personal', 'project']),
  enabled: z.boolean().default(true),
  invalidReason: z.string().optional(),
});
export type SkillRef = z.infer<typeof SkillRefSchema>;

/* ---------------- 类型清单 ---------------- */

export const TypeResourceSchema = z.object({
  path: z.string().min(1),
  mustRead: z.boolean().default(false),
});
export type TypeResource = z.infer<typeof TypeResourceSchema>;

export const TypeManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  model: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
  resources: z.array(TypeResourceSchema).default([]),
});
export type TypeManifest = z.infer<typeof TypeManifestSchema>;

/* ---------------- 文档 ---------------- */

export const ArtifactMetaSchema = z.object({
  title: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const ArtifactNodeSchema = z.object({
  group: z.string(),
  name: z.string(),
  title: z.string(),
  type: z.string(),
  updatedAt: z.string().optional(),
});
export type ArtifactNode = z.infer<typeof ArtifactNodeSchema>;

/* ---------------- 文档文件夹（创作会话内浏览） ---------------- */

/**
 * 文档目录里的一个文件/文件夹。
 * path 相对文档目录（例如 assets/images/a.jpg），统一正斜杠；
 * 隐藏项、符号链接不进入树。
 */
export interface DocFileNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  /** 文件字节数；目录没有 */
  size?: number;
  updatedAt?: string;
  /** 仅目录有；空目录为 [] */
  children?: DocFileNode[];
}

export const DocFileNodeSchema: z.ZodType<DocFileNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(['dir', 'file']),
    size: z.number().int().nonnegative().optional(),
    updatedAt: z.string().optional(),
    children: z.array(DocFileNodeSchema).optional(),
  }),
);

export const DocFileListingSchema = z.object({
  /** 相对 storageRoot 的文档目录，例如 docs/科普/兔子 */
  root: z.string(),
  entries: z.array(DocFileNodeSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** 超过条数/深度上限时只返回前一部分 */
  truncated: z.boolean(),
});
export type DocFileListing = z.infer<typeof DocFileListingSchema>;

export const DocFileContentSchema = z.object({
  /** 相对文档目录的路径 */
  path: z.string(),
  name: z.string(),
  kind: z.enum(['text', 'image', 'binary']),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /** 仅 text 有内容；image/binary 为 null */
  text: z.string().nullable(),
  /** 文本预览是否被大小上限截断 */
  truncated: z.boolean(),
});
export type DocFileContent = z.infer<typeof DocFileContentSchema>;

/* ---------------- 会话流 ---------------- */

export const SessionStatusSchema = z.enum(['idle', 'running', 'waiting', 'done', 'error']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** 新建会话的默认标题；发第一条消息后由服务端改成消息摘要 */
export const DEFAULT_CHAT_SESSION_TITLE = '新会话';

/** 一个文档可以有多个互不影响的创作会话（各自一份模型上下文与渲染日志） */
export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 服务端内存里的实时状态；进程重启后回到 idle */
  status: SessionStatusSchema.default('idle'),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatSessionListSchema = z.object({
  activeId: z.string(),
  sessions: z.array(ChatSessionSchema),
});
export type ChatSessionList = z.infer<typeof ChatSessionListSchema>;

// 'diagram' 仅保留用于回放旧会话中的工具块；不再注册对应工具。
export const ToolNameSchema = z.enum(['read', 'write', 'edit', 'ls', 'grep', 'mcp', 'research', 'diagram', 'archify', 'image']);
export type ToolName = z.infer<typeof ToolNameSchema>;

/**
 * 消息流里的生图结果：只记本地相对路径，由前端按 `assetBase` 映射到
 * `/api/docs/<group>/<name>/assets/...`；不存远程 URL / base64。
 */
export const GeneratedImageSchema = z.object({
  /** 相对文档目录的路径，例如 assets/images/城市夜景-1.jpg */
  path: z.string().min(1),
  alt: z.string().default(''),
  /** 实际生成尺寸，例如 2048x2048 */
  size: z.string().optional(),
});
export type GeneratedImage = z.infer<typeof GeneratedImageSchema>;

/* ---------------- Archify 结构图 ---------------- */

export const ArchifyTypeSchema = z.enum([
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
  'erd',
  'class',
  'tree',
  'timeline',
  'waterfall',
]);
export type ArchifyType = z.infer<typeof ArchifyTypeSchema>;

export const ArchifyDiagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']).default('error'),
  message: z.string(),
  subject: z.record(z.unknown()).default({}),
  evidence: z.record(z.unknown()).default({}),
  supportedFixes: z.array(z.string()).default([]),
});
export type ArchifyDiagnostic = z.infer<typeof ArchifyDiagnosticSchema>;

export const ArchifyLayoutReportSchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string(),
  issues: z.array(ArchifyDiagnosticSchema).default([]),
});
export type ArchifyLayoutReport = z.infer<typeof ArchifyLayoutReportSchema>;

export const ArchifySummarySchema = z.object({
  /** assets/diagrams/x.archify.json */
  sourcePath: z.string().min(1),
  /** assets/diagrams/x.archify.svg */
  posterPath: z.string().min(1),
  type: ArchifyTypeSchema,
  title: z.string(),
  /** 源 JSON 原始字节的 sha256 */
  revision: z.string().min(1),
  updatedAt: z.string(),
});
export type ArchifySummary = z.infer<typeof ArchifySummarySchema>;

export const ArchifyDocumentSchema = ArchifySummarySchema.extend({
  ir: z.record(z.unknown()),
  /** 沙箱 viewer 地址（缓存 HTML） */
  interactiveUrl: z.string(),
  warnings: z.array(z.string()).default([]),
  layout: ArchifyLayoutReportSchema.nullable().default(null),
});
export type ArchifyDocument = z.infer<typeof ArchifyDocumentSchema>;

export const ArchifySaveInputSchema = z.object({
  ir: z.record(z.unknown()),
  baseRevision: z.string().min(1).optional(),
  force: z.boolean().default(false),
  quality: z.enum(['standard', 'showcase']).default('showcase'),
});
export type ArchifySaveInput = z.infer<typeof ArchifySaveInputSchema>;

export const ArchifySaveResultSchema = ArchifyDocumentSchema;
export type ArchifySaveResult = z.infer<typeof ArchifySaveResultSchema>;

export const ArchifyValidateInputSchema = z.object({
  type: ArchifyTypeSchema,
  ir: z.record(z.unknown()),
  quality: z.enum(['standard', 'showcase']).default('showcase'),
});
export type ArchifyValidateInput = z.infer<typeof ArchifyValidateInputSchema>;

export const ArchifyValidateResultSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(ArchifyDiagnosticSchema).default([]),
  warnings: z.array(z.string()).default([]),
  layout: ArchifyLayoutReportSchema.nullable().default(null),
});
export type ArchifyValidateResult = z.infer<typeof ArchifyValidateResultSchema>;

/** 排版：只返回变换后的 IR，不写盘 */
export const ArchifyLayoutInputSchema = z.object({
  type: ArchifyTypeSchema,
  ir: z.record(z.unknown()),
});
export type ArchifyLayoutInput = z.infer<typeof ArchifyLayoutInputSchema>;

export const ArchifyLayoutResultSchema = z.object({
  ir: z.record(z.unknown()),
  applied: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type ArchifyLayoutResult = z.infer<typeof ArchifyLayoutResultSchema>;

/** 实时预览：只渲染到 .aidocs 缓存，不写源/海报/marker */
export const ArchifyPreviewInputSchema = ArchifyValidateInputSchema;
export type ArchifyPreviewInput = z.infer<typeof ArchifyPreviewInputSchema>;

export const ArchifyPreviewResultSchema = ArchifyValidateResultSchema.extend({
  previewUrl: z.string().nullable(),
});
export type ArchifyPreviewResult = z.infer<typeof ArchifyPreviewResultSchema>;

/**
 * AI 直接改 IR（不经 pi 会话）：
 * - edit：按自然语言要求改；
 * - repair：按 diagnostics 修复。
 */
export const ArchifyAiInputSchema = z
  .object({
    mode: z.enum(['edit', 'repair']).default('edit'),
    type: ArchifyTypeSchema,
    ir: z.record(z.unknown()),
    instruction: z.string().trim().max(2000).optional(),
    diagnostics: z.array(ArchifyDiagnosticSchema).default([]),
    quality: z.enum(['standard', 'showcase']).default('showcase'),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'edit' && !value.instruction) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请填写修改要求', path: ['instruction'] });
    }
    if (value.mode === 'repair' && value.diagnostics.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '缺少待修复的诊断', path: ['diagnostics'] });
    }
  });
export type ArchifyAiInput = z.infer<typeof ArchifyAiInputSchema>;

export const ArchifyAiResultSchema = z.object({
  /** 模型返回的完整 IR（已过 schema 校验；ok=false 时仍可能带诊断） */
  ir: z.record(z.unknown()),
  summary: z.string().default(''),
  ok: z.boolean(),
  diagnostics: z.array(ArchifyDiagnosticSchema).default([]),
  /** provider/model，便于排查 */
  model: z.string().default(''),
});
export type ArchifyAiResult = z.infer<typeof ArchifyAiResultSchema>;

/* ---------------- 澄清选择 ---------------- */

export const ClarificationOptionSchema = z.object({
  label: z.string(),
  /** 回给模型的答案文本；缺省用 label */
  value: z.string(),
  description: z.string().optional(),
});
export type ClarificationOption = z.infer<typeof ClarificationOptionSchema>;

export const ClarificationQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(ClarificationOptionSchema).min(2),
  /** 允许「其他」自由输入 */
  allowOther: z.boolean().default(true),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

export const ClarificationBlockSchema = z.object({
  kind: z.literal('clarification'),
  /** 一次提问（1–3 题）共用一个 groupId，提交时整组回传 */
  groupId: z.string(),
  intro: z.string().optional(),
  questions: z.array(ClarificationQuestionSchema).min(1),
  status: z.enum(['pending', 'answered', 'expired']),
  /** questionId → 用户选择/自由输入 */
  answers: z.record(z.string()).optional(),
});
export type ClarificationBlock = z.infer<typeof ClarificationBlockSchema>;

export const BlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), streaming: z.boolean().optional() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    tool: ToolNameSchema,
    title: z.string(),
    detail: z.string().optional(),
    status: z.enum(['running', 'ok', 'error']),
  }),
  z.object({
    kind: z.literal('attachment'),
    files: z.array(z.object({ name: z.string(), size: z.number(), relPath: z.string() })),
  }),
  z.object({
    kind: z.literal('selection'),
    source: z.string(),
    chars: z.number(),
    preview: z.string(),
  }),
  /** 生图结果格子：图片已落盘，前端用 assetBase 解析缩略图与放大图 */
  z.object({ kind: z.literal('images'), images: z.array(GeneratedImageSchema).min(1) }),
  ClarificationBlockSchema,
  z.object({ kind: z.literal('error'), text: z.string() }),
]);
export type Block = z.infer<typeof BlockSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  mergeKey: z.string(),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(BlockSchema),
  round: z.number().int().optional(),
  /** 本轮最终回复：刷新回放只保留带此标记的 assistant 文本（加用户消息） */
  final: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), seq: z.number().int(), at: z.string(), message: ChatMessageSchema }),
  z.object({ type: z.literal('status'), seq: z.number().int(), at: z.string(), status: SessionStatusSchema }),
  z.object({ type: z.literal('notice'), seq: z.number().int(), at: z.string(), level: z.enum(['info', 'warn', 'error']), text: z.string() }),
  z.object({ type: z.literal('heartbeat'), seq: z.number().int(), at: z.string() }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
/** 写入用草稿：seq/at 由服务端补，且必须对联合成员**分发**（Omit 直接作用在联合上会塌成公共键） */
export type ChatEventDraft = ChatEvent extends infer E ? (E extends ChatEvent ? Omit<E, 'seq' | 'at'> & { at?: string } : never) : never;

/* ---------------- 请求体 ---------------- */

/** 用户从正文/原文编辑器里右键加入的选区上下文；发送成功后即清空，不重复送。 */
export const SelectionSchema = z.object({
  source: z.string(),
  chars: z.number().int().nonnegative(),
  preview: z.string(),
  text: z.string(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const SendMessageSchema = z.object({
  text: z.string(),
  mode: z.enum(['steer', 'followUp']).optional(),
  attachments: z.array(z.object({ name: z.string(), size: z.number(), relPath: z.string() })).default([]),
  selections: z.array(SelectionSchema).default([]),
});
export type SendMessage = z.infer<typeof SendMessageSchema>;

/** 回答一次澄清提问：groupId 对应聊天里那张卡，answers 是 questionId → 选择 */
export const ClarificationAnswerSchema = z.object({
  groupId: z.string().min(1),
  answers: z.record(z.string().max(500)).default({}),
});
export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>;

export const GitCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  at: z.string(),
  author: z.string(),
  summary: z.string(),
  origin: z.enum(['ai', 'human', 'other']),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

/* ---------------- 设置 / 存储（M2） ---------------- */

export const GitHeadSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  at: z.string(),
  author: z.string(),
  summary: z.string(),
});
export type GitHead = z.infer<typeof GitHeadSchema>;

export const GitRemoteSchema = z.object({
  /** 远端名，如 origin；没有远端时为 null */
  name: z.string().nullable().default(null),
  /** 展示用地址（已去掉账号 / token） */
  url: z.string().nullable().default(null),
  /** 用来比较的远端引用，如 origin/main；没有 tracking ref 时为 null */
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().min(0).default(0),
  behind: z.number().int().min(0).default(0),
});
export type GitRemote = z.infer<typeof GitRemoteSchema>;

export const GitStatusSchema = z.object({
  isRepo: z.boolean().default(false),
  branch: z.string().nullable().default(null),
  lastCommit: GitHeadSchema.nullable().default(null),
  dirty: z.boolean().default(false),
  /** 尚未解决的冲突文件（相对 storageRoot） */
  conflicted: z.array(z.string()).default([]),
  /** 合并 / rebase / cherry-pick 进行中 */
  merging: z.boolean().default(false),
  remote: GitRemoteSchema.default({ name: null, url: null, upstream: null, ahead: 0, behind: 0 }),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const StorageStateSchema = z.object({
  storageRoot: z.string(),
  git: GitStatusSchema,
});
export type StorageState = z.infer<typeof StorageStateSchema>;

export const GitSyncActionSchema = z.enum(['pull', 'push']);
export type GitSyncAction = z.infer<typeof GitSyncActionSchema>;

/** 推送前按文件夹切出的一个提交（一个 Artifact / 类型 / 技能 / 根目录一组） */
export const GitSyncCommitSchema = z.object({
  /** 分组路径，如 docs/JW/智能网关、types/技术方案、skills/写作、或 .（根目录） */
  path: z.string(),
  /** 提交摘要里用的中文标签 */
  label: z.string(),
  sha: z.string(),
  /** 该组包含的变更文件数 */
  files: z.number().int().min(0).default(0),
});
export type GitSyncCommit = z.infer<typeof GitSyncCommitSchema>;

export const GitSyncResultSchema = z.object({
  ok: z.boolean(),
  action: GitSyncActionSchema,
  reason: z.enum(['ok', 'conflict', 'behind', 'error']),
  message: z.string(),
  /** 冲突文件（相对 storageRoot）；非冲突时为空 */
  files: z.array(z.string()).default([]),
  /** 已自动启动的 pi 修复任务；没有可用模型时为 null */
  repairId: z.string().nullable().default(null),
  /** 推送前按文件夹生成的提交；没有未提交改动时为空 */
  commits: z.array(GitSyncCommitSchema).default([]),
  status: GitStatusSchema,
});
export type GitSyncResult = z.infer<typeof GitSyncResultSchema>;

/* ---------------- git 冲突修复（pi） ---------------- */

export type RepairStatus = 'running' | 'done' | 'error' | 'aborted';

/** 冲突修复任务往设置页推送的事件；SSE 的 event 名与 type 一致 */
export type RepairEvent =
  | { type: 'status'; status: RepairStatus; text?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; path?: string; status: 'running' | 'ok' | 'error'; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export type RepairEventRecord = RepairEvent & { seq: number; at: string };

export interface RepairSnapshot {
  id: string;
  files: string[];
  status: RepairStatus;
  events: RepairEventRecord[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/* ---------------- 资料查询（DeepSeek Search/Fetch） ---------------- */

/**
 * 资料查询插件的全局配置。
 * 没有启用开关：创作会话始终注入 research_* 工具；配置不可用时降级为无工具 + warn notice。
 * key 不在这里：只从「模型供应商」借用所选供应商的 apiKey；baseUrl 只决定接口地址。
 */
export const ResearchSettingsSchema = z.object({
  /** 借用哪条供应商的 API Key；null = 自动挑 baseUrl 指向 deepseek.com 的第一条 */
  providerId: z.string().nullable().default(null),
  /** 资料查询接口地址，默认 DeepSeek 官方 */
  baseUrl: z.string().trim().default('https://api.deepseek.com'),
  /** 单次搜索默认返回条数（1–50） */
  count: z.number().int().min(1).max(50).default(8),
  /** 搜索默认是否返回网页正文（正文很大，默认关） */
  needContent: z.boolean().default(false),
  /** 关掉的数据源 id；新加的数据源默认开启，因此这里存「停用」而不是「启用」 */
  disabledSources: z.array(z.string()).default([]),
});
export type ResearchSettings = z.infer<typeof ResearchSettingsSchema>;

/** GET /api/research/sources 的一行：给设置页展示与勾选 */
export const ResearchSourceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** 这个源该在什么场景用（给模型的路由说明，同时展示在设置页） */
  routing: z.string(),
  needsKey: z.boolean().default(false),
  /** 是否「每次搜索都会带上」（DeepSeek 联网搜索） */
  always: z.boolean().default(false),
});
export type ResearchSourceInfo = z.infer<typeof ResearchSourceInfoSchema>;

export const ResearchTestInputSchema = z.object({
  baseUrl: z.string().trim().optional(),
  providerId: z.string().nullable().optional(),
});
export type ResearchTestInput = z.infer<typeof ResearchTestInputSchema>;

/** POST /api/research/test：连接探针结果（失败也返回 200） */
export const ResearchTestResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string(),
  latencyMs: z.number().int().min(0),
  sample: z.object({ title: z.string(), url: z.string() }).nullable().default(null),
});
export type ResearchTestResult = z.infer<typeof ResearchTestResultSchema>;

/* ---------------- 生图（火山引擎 Seedream） ---------------- */

export const SEEDREAM_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-5-0-flash-260915';
/** 文章插图默认 3:2；工具参数 size 可覆盖 */
export const SEEDREAM_DEFAULT_SIZE = '1536x1024';
/**
 * 设置页「默认模型」的下拉预设。只是常用项，字段本身仍接受手填：
 * 其它 5.0 / 4.5 / 4.0 模型 ID 或 Ark Endpoint ID 都合法。
 */
export const SEEDREAM_MODEL_PRESETS = [
  { id: 'doubao-seedream-5-0-pro-260628', hint: '图层拆分 / 交互编辑 / 透明背景' },
  { id: 'doubao-seedream-5-0-flash-260915', hint: '图层拆分 / 交互编辑 / 更快' },
] as const;
export type SeedreamModelPreset = (typeof SEEDREAM_MODEL_PRESETS)[number];
/** 设置页「默认尺寸」的常用预设；字段本身也接受手填其它宽x高 */
export const SEEDREAM_SIZE_PRESETS = [
  { id: '1536x1024', hint: '3:2 · 文章插图' },
  { id: '2048x1152', hint: '16:9 · 横幅' },
  { id: '1024x1024', hint: '1:1 · 方图' },
  { id: '2048x2048', hint: '1:1 · 2K' },
] as const;
export type SeedreamSizePreset = (typeof SEEDREAM_SIZE_PRESETS)[number];

/**
 * 生图插件配置（config.json 顶层 `seedream`，不在 settings 里）。
 * `apiKey` 只存服务端；GET /api/seedream 返回掩码 + hasKey。
 * 参考图上传复用同一个 baseUrl/apiKey 的 Files API，没有独立的临时存储配置。
 */
export const SeedreamSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().trim().default(SEEDREAM_DEFAULT_BASE_URL),
  model: z.string().trim().default(SEEDREAM_DEFAULT_MODEL),
  size: z.string().trim().default(SEEDREAM_DEFAULT_SIZE),
  apiKey: z.string().default(''),
});
export type SeedreamSettings = z.infer<typeof SeedreamSettingsSchema>;

/** 下行视图：apiKey 掩码，hasKey 表示服务端是否已存密钥 */
export const SeedreamViewSchema = SeedreamSettingsSchema.extend({
  apiKey: z.string(),
  hasKey: z.boolean(),
});
export type SeedreamView = z.infer<typeof SeedreamViewSchema>;

/** PUT /api/seedream 的局部补丁；apiKey 空 = 保持原值 */
export const SeedreamPatchSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().min(1, 'Base URL 不能为空').optional(),
  model: z.string().trim().min(1, '模型不能为空').optional(),
  size: z.string().trim().optional(),
  apiKey: z.string().optional(),
});
export type SeedreamPatch = z.infer<typeof SeedreamPatchSchema>;

export const SeedreamTestResultSchema = z.object({
  ok: z.boolean(),
  /** 模型接口（Ark 鉴权探针）是否通过；整体 ok 还要求 files 通过 */
  arkOk: z.boolean(),
  reason: z.string(),
  latencyMs: z.number().int().min(0),
  model: z.string(),
  /** Files API 上传探针；没 key/未尝试时为 null */
  files: z
    .object({
      ok: z.boolean(),
      reason: z.string(),
      fileId: z.string().nullable(),
      latencyMs: z.number().int().min(0),
    })
    .nullable()
    .default(null),
});
export type SeedreamTestResult = z.infer<typeof SeedreamTestResultSchema>;

/**
 * 思考强度（映射 pi 的 ThinkingLevel）。
 * 只开 off / low / medium / high 四档：xhigh、max 需要模型侧 thinkingLevelMap 显式映射，
 * 第三方供应商普遍不声明，选了也会被 pi 向下取整，故不暴露。
 */
export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** PUT /api/settings 的补丁；storageRoot 走存储校验，defaultModel 走供应商校验 */
export const SettingsPatchSchema = z.object({
  storageRoot: z.string().trim().min(1, '存储目录不能为空').optional(),
  autoCommit: z.boolean().optional(),
  aiCommitDebounceMs: z.number().int().min(0).max(600_000).optional(),
  humanCommitDebounceMs: z.number().int().min(0).max(600_000).optional(),
  defaultModel: z.string().nullable().optional(),
  /** 与默认模型同卡配置：会话创建时快照；off = 不向供应商发推理参数 */
  thinkingLevel: ThinkingLevelSchema.optional(),
  /** 整块替换（客户端必须发全量字段） */
  research: ResearchSettingsSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* ---------------- 请求体（M2） ---------------- */

export const ProviderInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, '名称不能为空'),
  protocol: ProtocolSchema,
  baseUrl: z.string().trim().min(1, 'Base URL 不能为空'),
  apiKey: z.string().optional(),
});
export type ProviderInput = z.infer<typeof ProviderInputSchema>;

export const ModelImportInputSchema = z.object({
  models: z.array(ModelInfoSchema).min(1, '至少选择一个模型'),
});
export type ModelImportInput = z.infer<typeof ModelImportInputSchema>;

/* ---------------- MCP（M2） ---------------- */

export const McpProbeResultSchema = z.object({
  state: z.enum(['ok', 'error']),
  toolCount: z.number().int().min(0).nullable().default(null),
  reason: z.string().default(''),
  checkedAt: z.string(),
});
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>;

export const McpProbeInputSchema = z.union([
  z.object({ name: z.string().min(1) }),
  z.object({ server: McpServerSchema }),
]);
export type McpProbeInput = z.infer<typeof McpProbeInputSchema>;

export const McpImportInputSchema = z.union([
  z.object({
    servers: z.array(McpServerSchema).min(1, '至少提供一个 MCP 配置'),
    clear: z.boolean().optional(),
  }),
  z.object({
    text: z.string().min(1, '贴入内容不能为空'),
    clear: z.boolean().optional(),
  }),
]);
export type McpImportInput = z.infer<typeof McpImportInputSchema>;

/* ---------------- Skills（M2） ---------------- */

export const SkillToggleInputSchema = z.object({
  name: z.string().min(1, '缺少技能名'),
  enabled: z.boolean(),
});
export type SkillToggleInput = z.infer<typeof SkillToggleInputSchema>;

export const SkillContentSchema = z.object({
  name: z.string(),
  origin: z.enum(['personal', 'project']),
  content: z.string(),
});
export type SkillContent = z.infer<typeof SkillContentSchema>;
