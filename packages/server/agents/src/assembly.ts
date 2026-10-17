import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, Model, ModelInputModality } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { McpServer, ThinkingLevel, TypeManifest } from '@aidocs/contracts';
import { mcpSpawnEnv } from '@aidocs/core';
import { ARCHIFY_TOOL_NAMES, createArchifyExtension } from './archify';
import { CLARIFICATION_TOOL, createClarificationTool, type ClarificationHub } from './clarify';
import { buildTypePrompt } from './prompt';
import { RESEARCH_TOOL_NAMES, createResearchExtension, type ResearchToolOptions } from './research';
import { SEEDREAM_TOOL_NAMES, createSeedreamExtension, type SeedreamToolOptions } from './seedream';

export interface PiProviderInput {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 声明模型支持图像输入；pi 的模型能力 input 会带上 image */
  supportsImages?: boolean;
}

export interface BuildSessionInput {
  artifactDir: string;
  sessionsDir: string;
  agentDir: string;
  manifest: TypeManifest;
  resources: string[];
  /** 该类型勾选、且全局启用的 MCP 服务器 */
  mcp?: McpServer[];
  /** 资料查询（DeepSeek）；默认注入，配置不可用时不给（降级） */
  research?: Omit<ResearchToolOptions, 'artifactDir'>;
  /** 生图（火山引擎）；启用且配置完整时才注册 seedream_image_generation */
  seedream?: Omit<SeedreamToolOptions, 'artifactDir'>;
  /** 澄清提问等待区；预览等只读装配也要给，保证工具清单与真实会话一致 */
  clarify?: ClarificationHub;
  provider: PiProviderInput;
  /** 类型的 prompt.md 正文 */
  promptText?: string;
  /** 思考强度：off/不给 = 不声明 reasoning（旧行为），其余档位按 pi 的 ThinkingLevel 透传 */
  thinkingLevel?: ThinkingLevel;
  /** 已有会话文件则续接 */
  sessionFile?: string;
  /** 只装配不落盘（注入预览用）：会话史留在内存里 */
  inMemorySession?: boolean;
}

export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'ls', 'grep'] as const;

/**
 * 思考强度 → pi 侧的模型能力 + 创建选项。
 * pi 的 getSupportedThinkingLevels() 对没有 `reasoning: true` 的模型只返回 ['off']，
 * 所以「开启思考」必须同时声明模型能力，否则选中的档位会被 clamp 成 off。
 * off/未设置时保持不声明，与加这个开关之前的行为完全一致。
 */
export function thinkingOptions(level: ThinkingLevel | undefined): {
  reasoning: boolean;
  level?: ThinkingLevel;
} {
  if (!level || level === 'off') return { reasoning: false };
  return { reasoning: true, level };
}

/** 模型能力 → pi 的输入模态；未声明或 false 都按仅文本处理 */
export function modelInputModalities(supportsImages: boolean | undefined): ModelInputModality[] {
  return supportsImages ? ['text', 'image'] : ['text'];
}

/** 类型 resources/ 里真实存在的文件 → 注入用的相对路径清单（只算路径，不落盘） */
export function listResources(typeDir: string, resources: string[]): string[] {
  const listed: string[] = [];
  for (const rel of resources) {
    if (!existsSync(join(typeDir, 'resources', rel))) continue;
    listed.push(`.aidocs/type/${rel}`);
  }
  return listed;
}

/** 物化类型资源到 <artifact>/.aidocs/type/，返回能给模型看的相对路径清单 */
export function materializeResources(artifactDir: string, typeDir: string, resources: string[]): string[] {
  mkdirSync(join(artifactDir, '.aidocs', 'type'), { recursive: true });
  return listResources(typeDir, resources);
}

export interface PiSessionHandle {
  session: import('@earendil-works/pi-coding-agent').AgentSession;
  dispose: () => void;
}

export interface PiModelHandle {
  runtime: ModelRuntime;
  model: Model<Api>;
  providerId: string;
}

/**
 * 只装配一个可调用的模型，不建会话、不加载技能/MCP。
 * 适合一次性结构化请求：直接 runtime.complete(model, context, options)。
 */
export async function buildPiModel(
  provider: PiProviderInput,
  thinkingLevel?: ThinkingLevel,
): Promise<PiModelHandle> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');

  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const providerId = `aidocs-${provider.id}`;
  const wire = provider.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses';
  const thinking = thinkingOptions(thinkingLevel);
  runtime.registerProvider(providerId, {
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: wire,
    models: [
      {
        id: provider.modelId,
        name: provider.modelId,
        api: wire,
        baseUrl: provider.baseUrl,
        input: modelInputModalities(provider.supportsImages),
        reasoning: thinking.reasoning,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: provider.contextWindow ?? 200_000,
        maxTokens: provider.maxOutputTokens ?? 8_192,
      },
    ],
  } as never);

  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  const model = runtime.getModel(providerId, provider.modelId);
  if (!model) throw new Error(`模型不可用：${provider.modelId}`);
  return { runtime, model, providerId };
}

/**
 * 装配一个 pi 会话（in-process SDK）。
 * 顺序照 docs/spec/20-architecture.md：ModelRuntime → registerProvider → setRuntimeApiKey
 * → resourceLoader → createAgentSession → bindExtensions。
 */
export async function buildPiSession(input: BuildSessionInput): Promise<PiSessionHandle> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { runtime, model } = await buildPiModel(input.provider, input.thinkingLevel);

  const typePrompt = buildTypePrompt(input.manifest, input.resources, input.promptText ?? '');
  const thinking = thinkingOptions(input.thinkingLevel);

  // 技能白名单：只有类型勾选的技能进上下文（票 07 决策；loader 默认会把发现的技能全塞进来）
  const allowedSkills = new Set(input.manifest.skills);
  // env 里补上启动器所在目录：uvx 装在 ~/.local/bin、Finder 启动的宿主 PATH 里没有它，
  // 不补这一步「探针绿了、会话里起不来」。用户自己写的 env 原样保留。
  const mcpServers = (input.mcp ?? []).map((server) => ({
    name: server.name,
    source: 'aidocs-settings',
    config:
      server.transport === 'stdio'
        ? {
            type: 'stdio' as const,
            command: server.command ?? '',
            args: server.args,
            env: mcpSpawnEnv(server),
          }
        : { type: 'http' as const, url: server.url ?? '', headers: server.headers },
  }));

  const loader = new sdk.DefaultResourceLoader({
    cwd: input.artifactDir,
    agentDir: input.agentDir,
    appendSystemPromptOverride: (base: string[]) => [...base, typePrompt],
    skillsOverride: (base: { skills: { name: string }[]; diagnostics: unknown[] }) => ({
      skills: base.skills.filter((skill) => allowedSkills.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
    extensionFactories: [
      sdk.createMcpExtension({
        loadConfig: () => ({ servers: mcpServers, errors: [] }),
      }),
      createArchifyExtension({ artifactDir: input.artifactDir }),
      ...(input.research
        ? [createResearchExtension({ ...input.research, artifactDir: input.artifactDir })]
        : []),
      ...(input.seedream
        ? [createSeedreamExtension({ ...input.seedream, artifactDir: input.artifactDir })]
        : []),
    ],
  } as never);
  await loader.reload();

  const sessionManager = input.inMemorySession
    ? sdk.SessionManager.inMemory(input.artifactDir)
    : input.sessionFile
      ? sdk.SessionManager.open(input.sessionFile)
      : sdk.SessionManager.create(input.artifactDir, input.sessionsDir);

  const { session } = await sdk.createAgentSession({
    cwd: input.artifactDir,
    agentDir: input.agentDir,
    modelRuntime: runtime,
    model,
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
    resourceLoader: loader,
    sessionManager,
    // 显式给了就压过会话里记录过的 thinking_level_change：设置页是唯一事实来源
    ...(thinking.level ? { thinkingLevel: thinking.level } : {}),
    // tools 是闭集白名单：扩展注册的自定义工具必须显式列进来
    tools: [
      ...ALLOWED_TOOLS,
      ...ARCHIFY_TOOL_NAMES,
      ...(input.research ? RESEARCH_TOOL_NAMES : []),
      ...(input.seedream ? SEEDREAM_TOOL_NAMES : []),
      ...(input.clarify ? [CLARIFICATION_TOOL] : []),
    ],
    ...(input.clarify ? { customTools: [createClarificationTool(input.clarify)] } : {}),
  } as never);

  await session.bindExtensions({ mode: 'rpc' } as never);

  return {
    session,
    dispose: () => {
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

export function latestSessionFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && f !== 'ui.jsonl' && !f.endsWith('.ui.jsonl'))
    .map((f) => join(dir, f))
    .sort();
  return files.at(-1);
}
