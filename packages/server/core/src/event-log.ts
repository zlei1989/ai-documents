import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { ChatEventSchema, type ChatEvent, type ChatEventDraft } from '@aidocs/contracts';

/**
 * 事件日志（每个会话一份 `sessions/<id>.ui.jsonl`；旧版为共享 `sessions/ui.jsonl`）的读写。
 *
 * 这里是「模型一跑，别的页面全卡」的根因所在，所以有两条硬约束：
 * 1. 追加必须是 O(1)：不再为了发号把整个文件读一遍（旧实现是 O(文件大小)，
 *    512MB 的日志每次追加要 1 秒以上，直接把事件循环堵死）。
 * 2. 回放必须是异步、流式的：大日志按行读，读一行让一次事件循环，
 *    不再用 `readFileSync` 造一个超过 V8 上限的大字符串。
 */

/** 超过这个体积就把旧事件裁掉，避免日志无限膨胀 */
export const EVENT_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** 裁剪后保留最近这么多字节 */
export const EVENT_LOG_KEEP_BYTES = 8 * 1024 * 1024;
/** 找最后一条 seq 时先看这么大的尾块，找不到再按 4 倍扩大 */
const TAIL_PROBE_BYTES = 256 * 1024;
const TAIL_PROBE_LIMIT = 64 * 1024 * 1024;

/** 每个日志文件已落盘的最大 seq；文件只被本进程追加，缓存即可 */
const lastSeqCache = new Map<string, number>();

/** 测试或外部改动文件后手动失效缓存 */
export function resetEventLogCache(file?: string): void {
  if (file === undefined) lastSeqCache.clear();
  else lastSeqCache.delete(file);
}

/** 从一行 JSON 里廉价地取出 seq（不解析整行，避免大事件也全量 parse） */
function seqOfLine(line: string): number | undefined {
  const at = line.indexOf('"seq":');
  if (at === -1) return undefined;
  const match = /^\d+/.exec(line.slice(at + 6, at + 24));
  if (!match) return undefined;
  const seq = Number(match[0]);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

/** 读文件尾部若干字节；截断时丢掉第一段半行，保证返回的每一行都完整 */
function readTailText(file: string, maxBytes: number): { text: string; truncated: boolean } {
  const size = statSync(file).size;
  if (size === 0) return { text: '', truncated: false };
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  return { text, truncated: start > 0 };
}

/** 扫尾块找最大的 seq；文件不存在/空/坏行都返回 0 */
function scanLastSeq(file: string): number {
  if (!existsSync(file)) return 0;
  let window = TAIL_PROBE_BYTES;
  for (;;) {
    const { text, truncated } = readTailText(file, window);
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim();
      if (!line) continue;
      const seq = seqOfLine(line);
      if (seq !== undefined) return seq;
    }
    // 已经读到头，或尾块里全是超长行：不再扩大
    if (!truncated || window >= TAIL_PROBE_LIMIT) return 0;
    window *= 4;
  }
}

/** 文件里已落盘的最大 seq；首次调用只读尾块，之后走缓存 */
export function lastEventSeq(file: string): number {
  const cached = lastSeqCache.get(file);
  if (cached !== undefined) return cached;
  const seq = scanLastSeq(file);
  lastSeqCache.set(file, seq);
  return seq;
}

/** 追加一条事件；seq 由缓存发号，不再读取历史 */
export function appendEvent(file: string, event: ChatEventDraft): ChatEvent {
  const seq = lastEventSeq(file) + 1;
  const full = ChatEventSchema.parse({ ...event, seq, at: event.at ?? new Date().toISOString() });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  lastSeqCache.set(file, seq);
  rotateIfNeeded(file);
  return full;
}

/** 读全部事件（同步）；只建议测试/小文件用，生产回放请用 readEventsAfter */
export function readEvents(file: string): ChatEvent[] {
  if (!existsSync(file)) return [];
  return parseLines(readFileSync(file, 'utf8').split('\n'));
}

/** 读最近若干字节的事件；用于会话重建时取最大轮次 */
export function readEventsTail(file: string, maxBytes = 4 * 1024 * 1024): ChatEvent[] {
  if (!existsSync(file)) return [];
  let window = Math.min(maxBytes, TAIL_PROBE_BYTES);
  for (;;) {
    const { text, truncated } = readTailText(file, window);
    const events = parseLines(text.split('\n'));
    if (events.length > 0) return events;
    if (!truncated || window >= Math.max(maxBytes, TAIL_PROBE_LIMIT)) return events;
    window *= 4;
  }
}

/** 异步、逐行回放：大日志也不会一次性占满事件循环 */
export async function readEventsAfter(file: string, afterSeq: number): Promise<ChatEvent[]> {
  if (!existsSync(file)) return [];
  const out: ChatEvent[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const seq = seqOfLine(line);
      // seq 只增不减：能跳过的行不必 parse
      if (seq !== undefined && seq <= afterSeq) continue;
      try {
        const parsed = ChatEventSchema.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.seq > afterSeq) out.push(parsed.data);
      } catch {
        /* 坏行跳过 */
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return out;
}

/**
 * 把日志裁到最近 keepBytes 左右（按整行切）。
 * 保留的行必须能完整解析，且最后一条 seq 与文件一致；否则放弃裁剪，避免误删当前轮。
 */
export function compactEventLog(file: string, keepBytes = EVENT_LOG_KEEP_BYTES): { kept: number; bytes: number } {
  if (!existsSync(file)) return { kept: 0, bytes: 0 };
  const size = statSync(file).size;
  if (size <= keepBytes) return { kept: countLines(readTailText(file, size).text), bytes: size };

  let window = keepBytes;
  for (;;) {
    const { text } = readTailText(file, window);
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const events = parseLines(complete.split('\n'));
    const lastSeq = scanLastSeq(file);
    const keptLastSeq = events.at(-1)?.seq ?? 0;
    // 尾块里没有完整事件（比如最后一条事件比 keepBytes 还大）就扩大窗口重试
    if (events.length > 0 && keptLastSeq === lastSeq) {
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, complete, 'utf8');
      renameSync(tmp, file);
      lastSeqCache.set(file, keptLastSeq);
      return { kept: events.length, bytes: Buffer.byteLength(complete) };
    }
    if (window >= size || window >= TAIL_PROBE_LIMIT * 2) return { kept: 0, bytes: size };
    window *= 4;
  }
}

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size <= EVENT_LOG_MAX_BYTES) return;
    compactEventLog(file, EVENT_LOG_KEEP_BYTES);
  } catch {
    /* 裁剪失败不影响本轮写入；下次追加再试 */
  }
}

function parseLines(lines: string[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ChatEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* 坏行跳过，不牵连别人 */
    }
  }
  return out;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter((line) => line.trim()).length;
}
