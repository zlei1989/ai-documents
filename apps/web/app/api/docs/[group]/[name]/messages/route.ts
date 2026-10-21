import { sendMessage } from '@aidocs/api';
import { SendMessageSchema } from '@aidocs/contracts';
import { httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ group: string; name: string }> }) {
  const { group, name } = await ctx.params;
  const sessionId = new URL(req.url).searchParams.get('session') ?? undefined;
  try {
    const body = SendMessageSchema.parse(await req.json());
    const result = await sendMessage(group, name, body, sessionId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message, context: error.context }, { status: httpStatusOf(error.code) });
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
