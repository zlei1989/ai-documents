import type { McpServer, TypeManifest } from '@aidocs/contracts';
import { buildPiSession, listResources, type PiProviderInput } from './assembly';
import { ClarificationHub } from './clarify';
import type { ResearchToolOptions } from './research';
import type { SeedreamToolOptions } from './seedream';

export interface PromptPreviewInput {
  /** 类型目录（里面有 resources/） */
  typeDir: string;
  /** 装配时的工作目录：真实创作时是该文档目录 */
  cwd: string;
  /** 技能/MCP 配置目录，与真实装配保持一致 */
  agentDir: string;
  manifest: TypeManifest;
  promptText: string;
  mcp?: McpServer[];
  /** 资料查询配置；与真实会话保持一致，预览里才能看到 research_* 工具 */
  research?: Omit<ResearchToolOptions, 'artifactDir'>;
  /** 生图配置；与真实会话保持一致，预览里才能看到 seedream_image_generation */
  seedream?: Omit<SeedreamToolOptions, 'artifactDir'>;
  provider: PiProviderInput;
}

export interface PromptPreview {
  /** 模型这一轮实际收到的完整系统提示词 */
  systemPrompt: string;
  chars: number;
  /** 这次装配实际声明的工具（含 MCP 工具） */
  tools: string[];
  /** 清单里真实存在、会出现在「可用资料」段的路径 */
  resources: string[];
  /** 计入本次装配的 MCP 服务器名 */
  mcpServers: string[];
  /** cwd 段显示的路径 */
  cwd: string;
}

/**
 * 用与真实创作完全相同的 `buildPiSession` 装配一个只读会话，取出最终系统提示词。
 * 不在 API 层拼字符串：预览错了就等于模型收到的内容错了，所以只认这一条路径。
 */
export async function buildPromptPreview(input: PromptPreviewInput): Promise<PromptPreview> {
  const resources = listResources(
    input.typeDir,
    input.manifest.resources.map((r) => r.path),
  );

  const handle = await buildPiSession({
    artifactDir: input.cwd,
    sessionsDir: '',
    agentDir: input.agentDir,
    manifest: input.manifest,
    resources,
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.research ? { research: input.research } : {}),
    ...(input.seedream ? { seedream: input.seedream } : {}),
    ...(input.promptText ? { promptText: input.promptText } : {}),
    provider: input.provider,
    inMemorySession: true,
    // 预览要看到模型真实能用的工具；无 UI 时 request 会直接按「未回答」返回
    clarify: new ClarificationHub(),
  });

  try {
    const systemPrompt = handle.session.systemPrompt;
    return {
      systemPrompt,
      chars: systemPrompt.length,
      tools: handle.session.getActiveToolNames(),
      resources,
      mcpServers: (input.mcp ?? []).map((server) => server.name),
      cwd: input.cwd,
    };
  } finally {
    handle.dispose();
  }
}
