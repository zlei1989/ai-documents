import { z } from 'zod';
import { readResource, resolveStorageRoot, writeResource } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';

const WriteResourceBody = z.object({ content: z.string() });

interface Context {
  params: Promise<{ name: string; path: string[] }>;
}

/** GET /api/types/:name/resources/<relPath>：读取资源文本 */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { name, path } = await context.params;
    const rel = path.join('/');
    return { path: rel, content: readResource(resolveStorageRoot(), name, rel) };
  })();
}

/** PUT /api/types/:name/resources/<relPath>：写入资源文本（落盘） */
export async function PUT(request: Request, context: Context) {
  return route(async () => {
    const { name, path } = await context.params;
    const rel = path.join('/');
    const body = validate(WriteResourceBody, await readJson(request));
    writeResource(resolveStorageRoot(), name, rel, body.content);
    return { path: rel, ok: true };
  })();
}
