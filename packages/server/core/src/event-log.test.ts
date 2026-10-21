import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  compactEventLog,
  lastEventSeq,
  readEvents,
  readEventsAfter,
  readEventsTail,
  resetEventLogCache,
} from './event-log';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  resetEventLogCache();
});

function tmpFile(name = 'ui.jsonl'): string {
  dir = mkdtempSync(join(tmpdir(), 'aidocs-eventlog-'));
  return join(dir, name);
}

function line(seq: number, text: string, at = '2026-10-21T00:00:00.000Z'): string {
  return `${JSON.stringify({
    seq,
    at,
    type: 'message',
    message: { id: `a-${seq}`, mergeKey: `a-${seq}`, role: 'assistant', round: 1, blocks: [{ kind: 'text', text }] },
  })}\n`;
}

describe('appendEvent', () => {
  it('追加成本不随日志变大而增长（不再为了发号读全文件）', () => {
    const file = tmpFile();
    // 8MB 历史：旧实现每次追加都要把它整个读一遍 + zod 校验，约 25ms/次
    const chunk = '字'.repeat(800);
    writeFileSync(file, Array.from({ length: 3000 }, (_, i) => line(i + 1, chunk)).join(''), 'utf8');
    resetEventLogCache(file);
    expect(statSync(file).size).toBeGreaterThan(7 * 1024 * 1024);

    const start = performance.now();
    for (let i = 0; i < 100; i += 1) appendEvent(file, { type: 'status', status: 'running' });
    const elapsed = performance.now() - start;

    expect(lastEventSeq(file)).toBe(3100);
    // 新实现 ~10ms；旧实现 ~2.5s。阈值留足 CI 抖动余量
    expect(elapsed).toBeLessThan(800);
  });

  it('进程重启后从尾块接上 seq，不会从头读', () => {
    const file = tmpFile();
    appendEvent(file, { type: 'status', status: 'idle' });
    appendEvent(file, { type: 'status', status: 'done' });
    resetEventLogCache(file);
    expect(lastEventSeq(file)).toBe(2);
    expect(appendEvent(file, { type: 'status', status: 'running' }).seq).toBe(3);
  });

  it('尾块里是超长事件时也能找到 seq', () => {
    const file = tmpFile();
    writeFileSync(file, line(1, 'a') + line(2, 'x'.repeat(1024 * 1024)), 'utf8');
    resetEventLogCache(file);
    expect(lastEventSeq(file)).toBe(2);
  });

  it('seq 在多次追加间连续', () => {
    const file = tmpFile();
    const first = appendEvent(file, { type: 'status', status: 'running' });
    const second = appendEvent(file, { type: 'status', status: 'done' });
    expect([first.seq, second.seq]).toEqual([1, 2]);
  });
});

describe('readEventsAfter', () => {
  it('异步回放只返回 seq > afterSeq 的事件，坏行跳过', async () => {
    const file = tmpFile();
    writeFileSync(file, line(1, '一') + 'not-json\n' + line(2, '二') + line(3, '三'), 'utf8');
    const events = await readEventsAfter(file, 1);
    expect(events.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('文件不存在时返回空数组', async () => {
    expect(await readEventsAfter(join(tmpdir(), 'aidocs-not-exist', 'ui.jsonl'), 0)).toEqual([]);
  });

  it('readEventsTail 能读到最近事件并定位最大轮次', () => {
    const file = tmpFile();
    appendEvent(file, {
      type: 'message',
      message: { id: 'u-1', mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '一' }], round: 7 },
    });
    appendEvent(file, { type: 'status', status: 'done' });
    expect(readEventsTail(file, 1024).length).toBe(2);
  });
});

describe('compactEventLog', () => {
  it('裁掉旧事件、保留最近一整段，seq 继续递增', async () => {
    const file = tmpFile();
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => line(i + 1, 'x'.repeat(200))).join(''), 'utf8');
    resetEventLogCache(file);
    const before = statSync(file).size;

    const result = compactEventLog(file, 64 * 1024);
    expect(result.kept).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThan(before / 2);

    const events = readEvents(file);
    expect(events.at(-1)?.seq).toBe(500);
    expect(events[0]!.seq).toBeGreaterThan(1);
    // 第一条必须是完整事件（不是被截断的半行）
    expect(events[0]!.type).toBe('message');
    expect(await readEventsAfter(file, 499)).toHaveLength(1);
    expect(appendEvent(file, { type: 'status', status: 'done' }).seq).toBe(501);
  });

  it('单条事件比保留窗口还大时宁可不裁，也不丢当前轮', () => {
    const file = tmpFile();
    writeFileSync(file, line(1, 'x'.repeat(100 * 1024)), 'utf8');
    const before = statSync(file).size;
    const result = compactEventLog(file, 1024);
    expect(result.kept).toBe(1);
    expect(statSync(file).size).toBe(before);
    expect(readEvents(file)).toHaveLength(1);
  });
});
