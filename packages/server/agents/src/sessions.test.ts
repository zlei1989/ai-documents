import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionNotFoundError,
  createDocSession,
  ensureSessionIndex,
  findSessionFile,
  listDocSessions,
  liveSessionStatus,
  sessionIndexPath,
  sessionUiLog,
  setActiveDocSession,
  touchDocSession,
} from './sessions';

let dirs: string[] = [];

function tmpDoc(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aidocs-sessions-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

/** 手写一份 pi 会话文件：header + 若干 user/assistant 消息 */
function writePiSession(dir: string, id: string, messages: { role: 'user' | 'assistant'; text: string }[], iso: string): string {
  const file = join(dir, 'sessions', `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: iso, cwd: dir }),
    ...messages.map((message, index) =>
      JSON.stringify({
        type: 'message',
        id: `m${index + 1}`,
        parentId: index === 0 ? null : `m${index}`,
        timestamp: iso,
        message: {
          role: message.role,
          content: [{ type: 'text', text: message.text }],
          timestamp: Date.parse(iso) + index,
        },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('会话索引', () => {
  it('空文档：自动建一个默认会话并落索引', async () => {
    const dir = tmpDoc();

    const index = await ensureSessionIndex(dir);

    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]?.title).toBe('新会话');
    expect(index.activeId).toBe(index.sessions[0]?.id);
    expect(existsSync(sessionIndexPath(dir))).toBe(true);
  });

  it('采用已有 pi 会话：标题取第一条用户消息，active 取最近使用', async () => {
    const dir = tmpDoc();
    writePiSession(dir, 'older-session', [{ role: 'user', text: '旧的上下文' }], '2026-01-01T00:00:00.000Z');
    writePiSession(
      dir,
      'newer-session',
      [
        { role: 'user', text: '  帮我写一篇   智能网关的长文  ' },
        { role: 'assistant', text: '好的' },
      ],
      '2026-02-01T00:00:00.000Z',
    );

    const index = await ensureSessionIndex(dir);

    expect(index.sessions.map((session) => session.id)).toEqual(['newer-session', 'older-session']);
    expect(index.sessions[0]?.title).toBe('帮我写一篇 智能网关的长文');
    expect(index.activeId).toBe('newer-session');
  });

  it('旧版共享 ui.jsonl 归到最近的 pi 会话，改名成 <id>.ui.jsonl', async () => {
    const dir = tmpDoc();
    writePiSession(dir, 'abc123', [{ role: 'user', text: '旧会话' }], '2026-01-01T00:00:00.000Z');
    writeFileSync(
      join(dir, 'sessions', 'ui.jsonl'),
      `${JSON.stringify({ type: 'message', seq: 1, at: '2026-01-01T00:00:00.000Z', message: { id: 'u-1', mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '旧会话' }], round: 1 } })}\n`,
      'utf8',
    );

    const index = await ensureSessionIndex(dir);

    expect(index.activeId).toBe('abc123');
    expect(existsSync(join(dir, 'sessions', 'ui.jsonl'))).toBe(false);
    expect(existsSync(sessionUiLog(dir, 'abc123'))).toBe(true);
  });

  it('只有 ui.jsonl、没有 pi 文件：仍保留为「历史会话」并迁移渲染日志', async () => {
    const dir = tmpDoc();
    writeFileSync(join(dir, 'sessions', 'ui.jsonl'), '{"type":"status","seq":1,"status":"done"}\n', 'utf8');

    const index = await ensureSessionIndex(dir);

    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]?.title).toBe('历史会话');
    expect(index.sessions[0]?.id.startsWith('legacy-')).toBe(true);
    expect(existsSync(sessionUiLog(dir, index.sessions[0]!.id))).toBe(true);
  });

  it('索引损坏时重新盘点，不把文档卡死', async () => {
    const dir = tmpDoc();
    writeFileSync(sessionIndexPath(dir), '{ not-json', 'utf8');

    const index = await ensureSessionIndex(dir);

    expect(index.sessions).toHaveLength(1);
    expect(JSON.parse(readFileSync(sessionIndexPath(dir), 'utf8')).version).toBe(1);
  });
});

describe('新建与切换', () => {
  it('新建会话放到最前并成为 active，切换后 activeId 持久化', async () => {
    const dir = tmpDoc();
    const first = await ensureSessionIndex(dir);
    const created = await createDocSession(dir);

    let index = await listDocSessions(dir);
    expect(index.activeId).toBe(created.id);
    expect(index.sessions[0]?.id).toBe(created.id);
    expect(index.sessions).toHaveLength(2);

    await setActiveDocSession(dir, first.sessions[0]!.id);
    index = await listDocSessions(dir);
    expect(index.activeId).toBe(first.sessions[0]!.id);

    const reloaded = JSON.parse(readFileSync(sessionIndexPath(dir), 'utf8'));
    expect(reloaded.activeId).toBe(first.sessions[0]!.id);
  });

  it('切换不存在的会话抛 SessionNotFoundError；非法 id 不拼路径', async () => {
    const dir = tmpDoc();
    await ensureSessionIndex(dir);

    await expect(setActiveDocSession(dir, 'missing')).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(() => sessionUiLog(dir, '../escape')).toThrow(SessionNotFoundError);
  });

  it('并发发消息/切换时索引写入串行：标题不丢，activeId 不被旧快照覆盖', async () => {
    const dir = tmpDoc();
    const first = await createDocSession(dir);
    const second = await createDocSession(dir);

    await Promise.all([
      touchDocSession(dir, first.id, '第一个会话的标题'),
      touchDocSession(dir, second.id, '第二个会话的标题'),
      setActiveDocSession(dir, first.id),
    ]);

    const index = await listDocSessions(dir);
    expect(index.activeId).toBe(first.id);
    expect(index.sessions.find((session) => session.id === first.id)?.title).toBe('第一个会话的标题');
    expect(index.sessions.find((session) => session.id === second.id)?.title).toBe('第二个会话的标题');
  });
});

describe('touchDocSession', () => {
  it('「新会话」在第一条消息后换成消息摘要；已有自定义标题不动', async () => {
    const dir = tmpDoc();
    const created = await createDocSession(dir);

    const updated = await touchDocSession(dir, created.id, '  第一条\n消息  ');
    expect(updated?.title).toBe('第一条 消息');
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    // 另一个文档：pi 会话自带 session_info 名称时优先用名称
    const namedDir = tmpDoc();
    writePiSession(namedDir, 'named', [{ role: 'user', text: '正文' }], '2026-03-01T00:00:00.000Z');
    const file = join(namedDir, 'sessions', '2026-03-01T00-00-00-000Z_named.jsonl');
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}${JSON.stringify({ type: 'session_info', id: 'n1', parentId: 'm1', timestamp: '2026-03-01T00:00:01.000Z', name: '命名会话' })}\n`,
      'utf8',
    );
    const index = await ensureSessionIndex(namedDir);
    const named = index.sessions.find((session) => session.id === 'named');
    expect(named?.title).toBe('命名会话');

    const touched = await touchDocSession(namedDir, 'named', '不该覆盖标题');
    expect(touched?.title).toBe('命名会话');
  });
});

describe('findSessionFile', () => {
  it('同时支持 <id>.jsonl 与 pi 的 <ISO>_<id>.jsonl 命名', () => {
    const dir = tmpDoc();
    writeFileSync(join(dir, 'sessions', 'plain.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'sessions', '2026-01-01T00-00-00-000Z_stamped.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(dir, 'sessions', 'stamped.ui.jsonl'), '{}\n', 'utf8');

    expect(findSessionFile(dir, 'plain')).toBe(join(dir, 'sessions', 'plain.jsonl'));
    expect(findSessionFile(dir, 'stamped')).toBe(join(dir, 'sessions', '2026-01-01T00-00-00-000Z_stamped.jsonl'));
    expect(findSessionFile(dir, 'missing')).toBeUndefined();
    expect(findSessionFile(dir, '../escape')).toBeUndefined();
  });
});

describe('liveSessionStatus', () => {
  it('没有运行时：已完成/出错沿用日志末态，残留的 running 回落为空闲', () => {
    const dir = tmpDoc();
    const done = 'done-session';
    const running = 'running-session';
    writeFileSync(
      sessionUiLog(dir, done),
      `${JSON.stringify({ type: 'status', seq: 1, at: '2026-01-01T00:00:00.000Z', status: 'done' })}\n`,
      'utf8',
    );
    writeFileSync(
      sessionUiLog(dir, running),
      `${JSON.stringify({ type: 'status', seq: 1, at: '2026-01-01T00:00:00.000Z', status: 'running' })}\n`,
      'utf8',
    );

    expect(liveSessionStatus(dir, done)).toBe('done');
    expect(liveSessionStatus(dir, running)).toBe('idle');
    expect(liveSessionStatus(dir, 'never-started')).toBe('idle');
  });
});
