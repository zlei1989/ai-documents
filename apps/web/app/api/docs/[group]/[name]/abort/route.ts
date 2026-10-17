import { abort, httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ group: string; name: string }> }) {
  const { group, name } = await ctx.params;
  try {
    await abort(group, name);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message }, { status: httpStatusOf(error.code) });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
