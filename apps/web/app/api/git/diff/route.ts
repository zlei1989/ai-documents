import { diffCommit, httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const group = url.searchParams.get('group');
  const name = url.searchParams.get('name');
  const sha = url.searchParams.get('sha');
  if (!group || !name || !sha) return Response.json({ error: '缺少参数' }, { status: 400 });
  try {
    return Response.json({ diff: diffCommit(group, name, sha) });
  } catch (error) {
    if (error instanceof ServiceError) return Response.json({ error: error.message }, { status: httpStatusOf(error.code) });
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
