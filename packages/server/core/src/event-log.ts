import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ChatEventSchema, type ChatEvent, type ChatEventDraft } from '@aidocs/contracts';

/** 追加一条事件；seq 由本模块发号（文件内最大 seq + 1） */
export function appendEvent(file: string, event: ChatEventDraft): ChatEvent {
  const events = readEvents(file);
  const seq = (events.at(-1)?.seq ?? 0) + 1;
  const full = ChatEventSchema.parse({ ...event, seq, at: event.at ?? new Date().toISOString() });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

/** 读全部事件；坏行跳过（一行坏了不牵连别人） */
export function readEvents(file: string): ChatEvent[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: ChatEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ChatEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function readEventsAfter(file: string, afterSeq: number): ChatEvent[] {
  return readEvents(file).filter((e) => e.seq > afterSeq);
}
