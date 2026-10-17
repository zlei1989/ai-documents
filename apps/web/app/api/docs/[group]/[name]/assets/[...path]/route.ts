import { readAsset, resolveStorageRoot } from '@aidocs/api';
import { isNotModified, rawAssetHeaders } from '../../../../../_lib/file-response';
import { route } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string; path: string[] }>;
}

async function serve(request: Request, context: Context, includeBody: boolean): Promise<Response> {
  return route<Context>(async () => {
    const { group, name, path } = await context.params;
    const asset = readAsset(resolveStorageRoot(), group, name, path.join('/'));
    const headers = rawAssetHeaders(asset);
    if (isNotModified(request, asset.etag)) return new Response(null, { status: 304, headers });
    if (!includeBody) return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array(asset.bytes), { status: 200, headers });
  })(request, context);
}

/** GET /api/docs/:group/:name/assets/:path：原始图片（path 相对 assets/） */
export async function GET(request: Request, context: Context) {
  return serve(request, context, true);
}

/** HEAD：与 GET 相同的头，无 body */
export async function HEAD(request: Request, context: Context) {
  return serve(request, context, false);
}
