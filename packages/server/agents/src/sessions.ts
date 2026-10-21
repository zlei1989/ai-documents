import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CHAT_SESSION_TITLE, type SessionStatus } from '@aidocs/contracts';
import { atomicWrite, readEventsTail } from '@aidocs/core';
import { getRuntime } from './registry';

/**
 * 一个文档的会话清单。
 *
 * 目录里真正承载模型上下文的是 pi 的 `sessions/<ISO>_<id>.jsonl`；本应用再给每个
 * 会话配一份同 id 的渲染日志 `<id>.ui.jsonl`。`.index.json` 只记清单（标题、活动
 * 会话与时间），让空会话（还没发第一条消息、pi 尚未落盘）也能出现在列表里。
 */
export const SESSION_INDEX_FILE = '.index.json';
export const SESSION_INDEX_VERSION = 1;
/** 尚未产生消息的会话，标题先占位，第一条用户消息后替换 */
const TITLE_MAX_CHARS = 28;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DocSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocSessionIndex {
  version: 1;
  activeId: string;
  sessions: DocSession[];
}

export class SessionNotFoundError extends Error {
  constructor(message = '会话不存在或已删除') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

export function sessionsDirOf(artifactDir: string): string {
  return join(artifactDir, 'sessions');
}

export function sessionIndexPath(artifactDir: string): string {
  return join(sessionsDirOf(artifactDir), SESSION_INDEX_FILE);
}

export function assertSessionId(id: string): string {
  // index 文件在用户的存储根里，不能把里面的字符串直接拼进路径
  if (!SESSION_ID_RE.test(id) || id === '.' || id === '..') {
    throw new SessionNotFoundError(`会话 id 不合法：${id}`);
  }
  return id;
}

export function sessionUiLog(artifactDir: string, sessionId: string): string {
  return join(sessionsDirOf(artifactDir), `${assertSessionId(sessionId)}.ui.jsonl`);
}

/** 旧版本的单会话渲染日志；采用新布局时迁移成 `<id>.ui.jsonl` */
export function legacyUiLog(artifactDir: string): string {
  return join(sessionsDirOf(artifactDir), 'ui.jsonl');
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `s-${stamp}-${rand}`;
}

/** 从会话索引里找 pi 会话文件：兼容 `<id>.jsonl` 与 pi 默认的 `<ISO>_<id>.jsonl` */
export function findSessionFile(artifactDir: string, sessionId: string): string | undefined {
  const dir = sessionsDirOf(artifactDir);
  if (!SESSION_ID_RE.test(sessionId) || !existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter(
    (file) => file.endsWith('.jsonl') && file !== 'ui.jsonl' && !file.endsWith('.ui.jsonl'),
  );
  const direct = `${sessionId}.jsonl`;
  if (files.includes(direct)) return join(dir, direct);
  const suffix = `_${sessionId}.jsonl`;
  const found = files.find((file) => file.endsWith(suffix));
  return found ? join(dir, found) : undefined;
}

/** 进程重启后运行时状态没了，但「已完成/出错」仍可从渲染日志最后一帧读出来 */
function lastLoggedStatus(artifactDir: string, sessionId: string): SessionStatus | null {
  const file = sessionUiLog(artifactDir, sessionId);
  if (!existsSync(file)) return null;
  try {
    const events = readEventsTail(file, 128 * 1024);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type === 'status') return event.status;
    }
  } catch {
    /* 日志坏行/读失败就当没有 */
  }
  return null;
}

/** 会话在服务端内存里的状态；没有运行时（或运行时尚未跑过）则回落到日志末尾的终态 */
export function liveSessionStatus(artifactDir: string, sessionId: string): SessionStatus {
  const runtime = getRuntime<{ getStatus?: () => SessionStatus }>(artifactDir, sessionId);
  const running = runtime?.getStatus?.();
  if (running && running !== 'idle') return running;
  const logged = lastLoggedStatus(artifactDir, sessionId);
  // running/waiting 只在有运行时才算数；进程重启后残留在日志里的运行态一律当空闲
  return logged === 'done' || logged === 'error' ? logged : 'idle';
}

/**
 * 切走一个空闲会话时释放它的运行时（MCP 子进程、模型上下文）。
 * 正在跑/等澄清的会话保留，切回来能看到它继续跑；释放后下次切回来会从会话文件重建。
 */
export function releaseIdleSessionRuntime(artifactDir: string, sessionId: string): void {
  const runtime = getRuntime<{ getStatus?: () => SessionStatus; dispose?: () => void }>(artifactDir, sessionId);
  if (!runtime?.dispose) return;
  const status = runtime.getStatus?.() ?? 'idle';
  if (status === 'running' || status === 'waiting') return;
  try {
    runtime.dispose();
  } catch {
    /* 释放失败不影响切换；进程内最多多留一份会话 */
  }
}

function isDocSession(value: unknown): value is DocSession {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    SESSION_ID_RE.test(entry.id) &&
    typeof entry.title === 'string' &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string'
  );
}

function normalizeIndex(raw: unknown): DocSessionIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== SESSION_INDEX_VERSION || !Array.isArray(value.sessions)) return null;
  const seen = new Set<string>();
  const sessions: DocSession[] = [];
  for (const item of value.sessions) {
    if (!isDocSession(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    sessions.push({
      id: item.id,
      title: item.title.trim() || DEFAULT_CHAT_SESSION_TITLE,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  if (sessions.length === 0) return null;
  const activeId = typeof value.activeId === 'string' && seen.has(value.activeId) ? value.activeId : sessions[0]!.id;
  return { version: SESSION_INDEX_VERSION, activeId, sessions };
}

/** 读索引；不存在或损坏时返回 null，交给 adoptSessions 重建 */
export function readSessionIndex(artifactDir: string): DocSessionIndex | null {
  const file = sessionIndexPath(artifactDir);
  if (!existsSync(file)) return null;
  try {
    return normalizeIndex(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeSessionIndex(artifactDir: string, index: DocSessionIndex): void {
  const sorted = sortSessions(index.sessions);
  const activeId = sorted.some((session) => session.id === index.activeId) ? index.activeId : (sorted[0]?.id ?? '');
  atomicWrite(
    sessionIndexPath(artifactDir),
    `${JSON.stringify({ version: SESSION_INDEX_VERSION, activeId, sessions: sorted }, null, 2)}\n`,
  );
}

function sortSessions(sessions: DocSession[]): DocSession[] {
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function isoOrNow(value: Date | undefined): string {
  const time = value?.getTime();
  return Number.isFinite(time) ? new Date(time as number).toISOString() : new Date().toISOString();
}

/** 列表标题：会话名优先，其次第一条用户消息；都不可用就显示默认标题 */
function titleOf(...values: (string | undefined)[]): string {
  for (const value of values) {
    const clean = value?.replace(/\s+/g, ' ').trim();
    if (!clean || clean === '(no messages)') continue;
    const chars = [...clean];
    return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join('')}…` : clean;
  }
  return DEFAULT_CHAT_SESSION_TITLE;
}

function legacySessionFromUiLog(artifactDir: string): DocSession | null {
  const file = legacyUiLog(artifactDir);
  if (!existsSync(file)) return null;
  try {
    const stats = statSync(file);
    const id = `legacy-${Math.trunc(stats.mtimeMs).toString(36)}`;
    const target = sessionUiLog(artifactDir, id);
    if (!existsSync(target)) renameSync(file, target);
    return {
      id,
      title: '历史会话',
      createdAt: new Date(stats.birthtimeMs || stats.mtimeMs).toISOString(),
      updatedAt: new Date(stats.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/** 首次进入旧文档：把磁盘上已有的 pi 会话与 legacy ui.jsonl 收编进索引 */
async function adoptSessions(artifactDir: string): Promise<DocSessionIndex> {
  const dir = sessionsDirOf(artifactDir);
  mkdirSync(dir, { recursive: true });

  let infos: Awaited<ReturnType<typeof SessionManager.list>> = [];
  try {
    infos = await SessionManager.list(artifactDir, dir);
  } catch {
    // 单个文件损坏不影响其它会话；最差退化成空清单，下面会补一个默认会话
    infos = [];
  }

  const byId = new Map<string, DocSession>();
  for (const info of infos) {
    if (!SESSION_ID_RE.test(info.id) || byId.has(info.id)) continue;
    byId.set(info.id, {
      id: info.id,
      title: titleOf(info.name, info.firstMessage),
      createdAt: isoOrNow(info.created),
      updatedAt: isoOrNow(info.modified),
    });
  }

  const sorted = sortSessions([...byId.values()]);
  const legacyLog = legacyUiLog(artifactDir);
  if (existsSync(legacyLog)) {
    if (sorted.length > 0) {
      // 旧版只有一个 ui.jsonl，归给最近使用的那个 pi 会话
      const target = sessionUiLog(artifactDir, sorted[0]!.id);
      if (!existsSync(target)) {
        try {
          renameSync(legacyLog, target);
        } catch {
          /* 迁移失败就保留旧文件，不阻塞进入文档 */
        }
      }
    } else {
      const legacy = legacySessionFromUiLog(artifactDir);
      if (legacy) sorted.push(legacy);
    }
  }

  if (sorted.length === 0) {
    const now = new Date().toISOString();
    sorted.push({ id: newSessionId(), title: DEFAULT_CHAT_SESSION_TITLE, createdAt: now, updatedAt: now });
  }

  const index: DocSessionIndex = { version: SESSION_INDEX_VERSION, activeId: sorted[0]!.id, sessions: sorted };
  writeSessionIndex(artifactDir, index);
  return index;
}

/** 同一文档的并发首读只做一次盘点；失败后允许下次重试 */
const adopting = new Map<string, Promise<DocSessionIndex>>();

export async function ensureSessionIndex(artifactDir: string): Promise<DocSessionIndex> {
  const existing = readSessionIndex(artifactDir);
  if (existing) return existing;
  const running = adopting.get(artifactDir);
  if (running) return running;
  const task = adoptSessions(artifactDir).finally(() => adopting.delete(artifactDir));
  adopting.set(artifactDir, task);
  return task;
}

/**
 * 同一文档的索引写操作串行化：两个会话同时发消息时，后写的 updatedAt/标题不能覆盖
 * 先写的 activeId（读-改-写窗口在 await 处会让出事件循环）。
 */
const indexQueues = new Map<string, Promise<unknown>>();

function withIndexLock<T>(artifactDir: string, task: () => Promise<T>): Promise<T> {
  const previous = indexQueues.get(artifactDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  // 队列上存的是「已吞掉失败」的版本，避免没人 await 时产生 unhandled rejection
  const tracked = next.catch(() => undefined).finally(() => {
    if (indexQueues.get(artifactDir) === tracked) indexQueues.delete(artifactDir);
  });
  indexQueues.set(artifactDir, tracked);
  return next;
}

export async function listDocSessions(artifactDir: string): Promise<DocSessionIndex> {
  const index = await ensureSessionIndex(artifactDir);
  const sessions = sortSessions(index.sessions);
  const activeId = sessions.some((session) => session.id === index.activeId) ? index.activeId : (sessions[0]?.id ?? '');
  // 索引里记录了 activeId，正常情况下不需要重写；只有坏数据兜底时才落盘
  if (activeId !== index.activeId) writeSessionIndex(artifactDir, { ...index, activeId });
  return { version: SESSION_INDEX_VERSION, activeId, sessions };
}

export function createDocSession(artifactDir: string): Promise<DocSession> {
  return withIndexLock(artifactDir, async () => {
    const index = await ensureSessionIndex(artifactDir);
    const now = new Date().toISOString();
    const session: DocSession = { id: newSessionId(), title: DEFAULT_CHAT_SESSION_TITLE, createdAt: now, updatedAt: now };
    writeSessionIndex(artifactDir, {
      version: SESSION_INDEX_VERSION,
      activeId: session.id,
      sessions: [session, ...index.sessions],
    });
    return session;
  });
}

export function setActiveDocSession(artifactDir: string, sessionId: string): Promise<void> {
  return withIndexLock(artifactDir, async () => {
    assertSessionId(sessionId);
    const index = await ensureSessionIndex(artifactDir);
    if (!index.sessions.some((session) => session.id === sessionId)) throw new SessionNotFoundError();
    writeSessionIndex(artifactDir, { ...index, activeId: sessionId });
  });
}

/** 取指定会话；不传 id 时取 activeId。索引不存在时会先盘点/建默认会话 */
export async function resolveDocSession(artifactDir: string, sessionId?: string): Promise<DocSession> {
  const index = await ensureSessionIndex(artifactDir);
  const wanted = sessionId ? assertSessionId(sessionId) : index.activeId;
  const found = index.sessions.find((session) => session.id === wanted);
  if (!found) throw new SessionNotFoundError();
  return found;
}

/**
 * 发送消息后刷新「最近使用时间」；新会话的第一条消息顺便拿来当标题。
 * 失败不抛：会话索引写不进去不应该让消息发送失败。
 */
export function touchDocSession(artifactDir: string, sessionId: string, text?: string): Promise<DocSession | undefined> {
  return withIndexLock(artifactDir, async () => {
    try {
      const index = await ensureSessionIndex(artifactDir);
      const found = index.sessions.find((session) => session.id === sessionId);
      if (!found) return undefined;
      const updated: DocSession = {
        ...found,
        title:
          found.title.trim() && found.title !== DEFAULT_CHAT_SESSION_TITLE
            ? found.title
            : titleOf(text, found.title || DEFAULT_CHAT_SESSION_TITLE),
        updatedAt: new Date().toISOString(),
      };
      writeSessionIndex(artifactDir, {
        ...index,
        sessions: index.sessions.map((session) => (session.id === sessionId ? updated : session)),
      });
      return updated;
    } catch {
      return undefined;
    }
  });
}
