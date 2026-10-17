import { rollbackTo, httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { group?: string; name?: string; sha?: string };
    if (!body.group || !body.name || !body.sha) return Response.json({ error: '缺少参数' }, { status: 400 });
    const result = rollbackTo(body.group, body.name, body.sha);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message, context: error.context }, { status: httpStatusOf(error.code) });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
