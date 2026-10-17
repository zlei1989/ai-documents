import { logCommits, httpStatusOf, ServiceError } from '@aidocs/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const group = url.searchParams.get('group');
  const name = url.searchParams.get('name');
  if (!group || !name) return Response.json({ error: '缺少 group/name' }, { status: 400 });
  try {
    return Response.json({ commits: logCommits(group, name) });
  } catch (error) {
    if (error instanceof ServiceError) return Response.json({ error: error.message }, { status: httpStatusOf(error.code) });
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
