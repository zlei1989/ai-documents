import { readDocFileRaw, resolveStorageRoot, ServiceError } from '@aidocs/api';
import { isNotModified, rawAssetHeaders } from '../../../../../_lib/file-response';
import { route } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** GET /api/docs/<group>/<name>/files/raw?path=：原始文件（图片 inline，其他 attachment） */
export async function GET(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name } = await context.params;
    const path = new URL(request.url).searchParams.get('path');
    if (!path) throw new ServiceError('VALIDATION', '缺少参数：path');
    const file = readDocFileRaw(resolveStorageRoot(), group, name, path);
    const headers = rawAssetHeaders(file);
    if (isNotModified(request, file.etag)) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(file.bytes), { status: 200, headers });
  })(request, context);
}
