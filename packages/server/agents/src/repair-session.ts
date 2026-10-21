import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { buildPiModel, type PiProviderInput } from './assembly';

/** 冲突修复只给文件工具：没有 bash / 网络 / 扩展，pi 不能绕过应用直接 reset/checkout */
export const REPAIR_TOOLS = ['read', 'write', 'edit', 'ls', 'grep'] as const;

export interface RepairSessionInput {
  /** 仓库根目录（= storageRoot） */
  cwd: string;
  agentDir: string;
  provider: PiProviderInput;
  /** 追加到 pi 默认提示词的修复规则；不加载类型方法论 / 技能 / MCP */
  systemPrompt: string;
}

export interface RepairSessionHandle {
  session: AgentSession;
  dispose: () => void;
}

/**
 * 只为 git 冲突修复装配一个最小 pi 会话。
 *
 * 与创作会话的区别：不加载 skills / MCP / Archify / research / seedream / AGENTS.md，
 * 工具白名单也只有 read/write/edit/ls/grep。修复任务生命周期短，会话史留在内存里。
 */
export async function buildRepairSession(input: RepairSessionInput): Promise<RepairSessionHandle> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { runtime, model } = await buildPiModel(input.provider);

  const loader = new sdk.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [input.systemPrompt],
  } as never);
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: runtime,
    model,
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(input.cwd),
    tools: [...REPAIR_TOOLS],
  } as never);

  try {
    await session.bindExtensions({ mode: 'rpc' } as never);
  } catch (error) {
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
    throw error;
  }

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
