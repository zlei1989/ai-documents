import { history, subscribeRuntime } from '@aidocs/api';
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
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? req.headers.get('last-event-id') ?? 0) || 0;
  // 刷新（afterSeq=0）默认只回放「用户说的 + 每轮最终回复 + 已答复澄清卡」；
  // 生成中/等待中则保留当前轮全部事件，刷新后仍能看到实时过程。?full=1 可看完整日志。
  const full = url.searchParams.get('full') === '1';

  let initial: ChatEvent[];
  try {
    initial = history(group, name, afterSeq);
    if (afterSeq === 0 && !full) initial = filterReplay(initial);
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), { status: 404 });
  }

  const rt = await subscribeRuntime(group, name);
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(': ready\n\n'));
      for (const event of initial) controller.enqueue(frame(event));

      unsubscribe = rt.subscribe((event: ChatEvent) => {
        try {
          controller.enqueue(frame(event));
        } catch {
          /* closed */
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);

      req.signal.addEventListener('abort', () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
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
