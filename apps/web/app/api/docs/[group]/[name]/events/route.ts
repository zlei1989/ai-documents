import { history, httpStatusOf, listChatSessions, ServiceError, subscribeRuntime } from '@aidocs/api';
import type { ChatEvent } from '@aidocs/contracts';
import { filterReplay } from '../../../../_lib/replay-filter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const enc = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function frame(event: ChatEvent): Uint8Array {
  return enc.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request, ctx: { params: Promise<{ group: string; name: string }> }) {
  const { group, name } = await ctx.params;

  const url = new URL(req.url);
  // 一个文档可以有多个会话；不带 session 时先解析 activeId 再固定下来，
  // 避免「读历史」与「建运行时」之间另一处切换会话导致串台（兼容旧调用）。
  let sessionId = url.searchParams.get('session') ?? undefined;
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? req.headers.get('last-event-id') ?? 0) || 0;
  // 刷新（afterSeq=0）默认只回放「用户说的 + 每轮最终回复 + 已答复澄清卡」；
  // 生成中/等待中则保留当前轮全部事件，刷新后仍能看到实时过程。?full=1 可看完整日志。
  const full = url.searchParams.get('full') === '1';

  let rt: Awaited<ReturnType<typeof subscribeRuntime>>;
  try {
    if (!sessionId) sessionId = (await listChatSessions(group, name)).activeId;
    // 先建/取运行时，后读历史；再在下面先挂监听、开流时补发缓冲，避免丢「读历史」窗口里的事件
    rt = await subscribeRuntime(group, name, sessionId);
  } catch (error) {
    const status = error instanceof ServiceError ? httpStatusOf(error.code) : 404;
    return new Response(JSON.stringify({ error: (error as Error).message }), { status });
  }

  const buffered: ChatEvent[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let live = false;
  const unsubscribe = rt.subscribe((event: ChatEvent) => {
    if (!live) {
      buffered.push(event);
      return;
    }
    try {
      streamController?.enqueue(frame(event));
    } catch {
      /* closed */
    }
  });

  let initial: ChatEvent[];
  let readThrough = afterSeq;
  try {
    const raw = await history(group, name, afterSeq, sessionId);
    for (const event of raw) readThrough = Math.max(readThrough, event.seq);
    initial = afterSeq === 0 && !full ? filterReplay(raw) : raw;
  } catch (error) {
    unsubscribe();
    const status = error instanceof ServiceError ? httpStatusOf(error.code) : 404;
    return new Response(JSON.stringify({ error: (error as Error).message }), { status });
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(enc.encode(': ready\n\n'));
      for (const event of initial) controller.enqueue(frame(event));
      // 读历史期间到达的事件：只补发历史没覆盖到的 seq，避免重复
      for (const event of buffered) {
        if (event.seq <= readThrough) continue;
        controller.enqueue(frame(event));
        readThrough = event.seq;
      }
      buffered.length = 0;
      live = true;

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);

      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
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
