import {
  abortCurrentMerge,
  abortRepair,
  attachRepair,
  getRepairSnapshot,
  startCurrentRepair,
} from '@aidocs/api';
import type { RepairEventRecord } from '@aidocs/contracts';
import { json, readJson, route } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const enc = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function frame(event: RepairEventRecord): Uint8Array {
  return enc.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function terminal(status: RepairEventRecord): boolean {
  return eventIsStatus(status) && status.status !== 'running';
}

function eventIsStatus(event: RepairEventRecord): event is Extract<RepairEventRecord, { type: 'status' }> {
  return event.type === 'status';
}

/**
 * GET /api/storage/repair?id=…            → 任务快照（JSON）
 * GET /api/storage/repair?id=…&stream=1   → SSE：status / text / tool / log
 * 支持 Last-Event-ID 重连只补新事件。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: '缺少 id' }, 400);

  if (url.searchParams.get('stream') !== '1') {
    const snapshot = getRepairSnapshot(id);
    return snapshot ? json(snapshot) : json({ error: '修复任务不存在或已过期' }, 404);
  }

  const afterSeq = Number(request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0) || 0;
  const buffered: RepairEventRecord[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let live = false;
  let finished = false;

  const send = (event: RepairEventRecord) => {
    if (event.seq <= afterSeq) return;
    try {
      streamController?.enqueue(frame(event));
    } catch {
      /* closed */
    }
  };

  const attached = attachRepair(id, (event) => {
    if (!live) {
      buffered.push(event);
      return;
    }
    send(event);
    if (terminal(event)) finished = true;
  });
  if (!attached) return json({ error: '修复任务不存在或已过期' }, 404);

  const { snapshot, unsubscribe } = attached;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let terminalWatch: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    if (terminalWatch) clearInterval(terminalWatch);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(enc.encode(': ready\n\n'));
      for (const event of snapshot.events) send(event);
      for (const event of buffered) send(event);
      buffered.length = 0;
      live = true;

      if (snapshot.status !== 'running') {
        finished = true;
      }

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);

      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      if (finished) {
        // 已结束的任务：补完历史就关流，避免 EventSource 自动重连
        setTimeout(close, 30).unref?.();
      } else {
        terminalWatch = setInterval(() => {
          if (!finished) return;
          cleanup();
          setTimeout(close, 30).unref?.();
        }, 100);
        terminalWatch.unref?.();
        request.signal.addEventListener('abort', () => {
          close();
        });
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** POST：{ action: 'start' | 'abort' | 'abort-merge', id? } */
export const POST = route(async (request) => {
  const body = (await readJson(request)) as { action?: unknown; id?: unknown };
  const action = typeof body?.action === 'string' ? body.action : 'start';
  if (action === 'start') return json(startCurrentRepair());
  if (action === 'abort') {
    if (typeof body?.id !== 'string' || !body.id) return json({ error: '缺少 id' }, 400);
    return json(await abortRepair(body.id));
  }
  if (action === 'abort-merge') return json({ git: abortCurrentMerge() });
  return json({ error: '未知操作' }, 400);
});
