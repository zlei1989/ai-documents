import { listDocFiles, resolveStorageRoot } from '@aidocs/api';
import { route } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** GET /api/docs/<group>/<name>/files：文档文件夹树（只读） */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    return listDocFiles(resolveStorageRoot(), group, name);
  })();
}
