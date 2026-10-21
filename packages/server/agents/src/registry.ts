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

/** 直接装配 ChatRuntime（测试/旧调用）时的会话 id；文档的真实会话 id 由索引给出 */
export const DEFAULT_SESSION_ID = 'default';

/** 同一文档可以并行多个会话，注册表按「文档目录 + 会话 id」隔离 */
export function sessionKey(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): string {
  return `${artifactDir}\u0000${sessionId}`;
}

export function getSession(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): AgentSession | undefined {
  return store[KEY]!.get(sessionKey(artifactDir, sessionId));
}

export function putSession(artifactDir: string, session: AgentSession, sessionId: string = DEFAULT_SESSION_ID): void {
  store[KEY]!.set(sessionKey(artifactDir, sessionId), session);
}

export function dropSession(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): void {
  const key = sessionKey(artifactDir, sessionId);
  const existing = store[KEY]!.get(key);
  if (existing) {
    existing.dispose();
    store[KEY]!.delete(key);
  }
}

export function getRuntime<T>(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): T | undefined {
  return runtimes[RT_KEY]!.get(sessionKey(artifactDir, sessionId)) as T | undefined;
}

export function putRuntime(artifactDir: string, runtime: unknown, sessionId: string = DEFAULT_SESSION_ID): void {
  runtimes[RT_KEY]!.set(sessionKey(artifactDir, sessionId), runtime);
}

export function dropRuntime(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): void {
  runtimes[RT_KEY]!.delete(sessionKey(artifactDir, sessionId));
}

/** 澄清等待区与运行时同生命周期；HMR 重建 runtime 时要复用同一个 hub */
export function getClarificationHub(
  artifactDir: string,
  sessionId: string = DEFAULT_SESSION_ID,
): ClarificationHub | undefined {
  return hubs[HUB_KEY]!.get(sessionKey(artifactDir, sessionId));
}

export function putClarificationHub(
  artifactDir: string,
  hub: ClarificationHub,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  hubs[HUB_KEY]!.set(sessionKey(artifactDir, sessionId), hub);
}

export function dropClarificationHub(artifactDir: string, sessionId: string = DEFAULT_SESSION_ID): void {
  hubs[HUB_KEY]!.delete(sessionKey(artifactDir, sessionId));
}

/**
 * 释放所有在跑的创作会话（如「资料查询」设置变更后）。
 * 会话的 dispose 会顺手关掉 MCP 子进程；下一次消息按新配置重建，历史靠会话文件续接。
 * 返回被释放的会话数。
 */
export function resetAllRuntimes(): number {
  const entries = [...runtimes[RT_KEY]!.entries()];
  for (const [key, runtime] of entries) {
    const disposable = runtime as { dispose?: () => void };
    try {
      disposable.dispose?.();
    } catch {
      /* 单个会话清理失败不影响其它 */
    }
    runtimes[RT_KEY]!.delete(key);
  }
  return entries.length;
}
