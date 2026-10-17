import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ClarificationHub } from './clarify';

const KEY = '__aidocs_sessions__';
const RT_KEY = '__aidocs_runtimes__';
const HUB_KEY = '__aidocs_clarify_hubs__';
const store = globalThis as unknown as Record<string, Map<string, AgentSession> | undefined>;
store[KEY] ??= new Map<string, AgentSession>();
const runtimes = globalThis as unknown as Record<string, Map<string, unknown> | undefined>;
runtimes[RT_KEY] ??= new Map<string, unknown>();
const hubs = globalThis as unknown as Record<string, Map<string, ClarificationHub> | undefined>;
hubs[HUB_KEY] ??= new Map<string, ClarificationHub>();

export function getSession(artifactDir: string): AgentSession | undefined {
  return store[KEY]!.get(artifactDir);
}

export function putSession(artifactDir: string, session: AgentSession): void {
  store[KEY]!.set(artifactDir, session);
}

export function dropSession(artifactDir: string): void {
  const existing = store[KEY]!.get(artifactDir);
  if (existing) {
    existing.dispose();
    store[KEY]!.delete(artifactDir);
  }
}


export function getRuntime<T>(artifactDir: string): T | undefined {
  return runtimes[RT_KEY]!.get(artifactDir) as T | undefined;
}

export function putRuntime(artifactDir: string, runtime: unknown): void {
  runtimes[RT_KEY]!.set(artifactDir, runtime);
}

export function dropRuntime(artifactDir: string): void {
  runtimes[RT_KEY]!.delete(artifactDir);
}

/** 澄清等待区与运行时同生命周期；HMR 重建 runtime 时要复用同一个 hub */
export function getClarificationHub(artifactDir: string): ClarificationHub | undefined {
  return hubs[HUB_KEY]!.get(artifactDir);
}

export function putClarificationHub(artifactDir: string, hub: ClarificationHub): void {
  hubs[HUB_KEY]!.set(artifactDir, hub);
}

export function dropClarificationHub(artifactDir: string): void {
  hubs[HUB_KEY]!.delete(artifactDir);
}

/**
 * 释放所有在跑的创作会话（如「资料查询」设置变更后）。
 * 会话的 dispose 会顺手关掉 MCP 子进程；下一次消息按新配置重建，历史靠会话文件续接。
 * 返回被释放的会话数。
 */
export function resetAllRuntimes(): number {
  const entries = [...runtimes[RT_KEY]!.entries()];
  for (const [artifactDir, runtime] of entries) {
    const disposable = runtime as { dispose?: () => void };
    try {
      disposable.dispose?.();
    } catch {
      /* 单个会话清理失败不影响其它 */
    }
    runtimes[RT_KEY]!.delete(artifactDir);
  }
  return entries.length;
}
