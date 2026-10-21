import { abort, httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ group: string; name: string }> }) {
  const { group, name } = await ctx.params;
  const sessionId = new URL(req.url).searchParams.get('session') ?? undefined;
  try {
    await abort(group, name, sessionId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message }, { status: httpStatusOf(error.code) });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
