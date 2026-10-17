import { ArchifySaveInputSchema } from '@aidocs/contracts';
import { getArchifyDocument, resolveStorageRoot, saveArchifyDocument } from '@aidocs/api';
import { readJson, route, validate } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string; path: string[] }>;
}

/** GET /api/docs/:group/:name/archify/assets/...x.archify.json */
export async function GET(_request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name, path } = await context.params;
    return getArchifyDocument(resolveStorageRoot(), group, name, path.join('/'));
  })();
}

/** PUT：保存 Archify IR（validate → render → poster/cache → 原子写） */
export async function PUT(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name, path } = await context.params;
    const body = validate(ArchifySaveInputSchema, await readJson(request));
    return saveArchifyDocument(resolveStorageRoot(), group, name, path.join('/'), body);
  })();
}
