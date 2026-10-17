import { readDocFile, resolveStorageRoot, ServiceError } from '@aidocs/api';
import { route } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** GET /api/docs/<group>/<name>/files/content?path=：文本/Markdown 预览与文件元信息 */
export async function GET(request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    const path = new URL(request.url).searchParams.get('path');
    if (!path) throw new ServiceError('VALIDATION', '缺少参数：path');
    return readDocFile(resolveStorageRoot(), group, name, path);
  })();
}
