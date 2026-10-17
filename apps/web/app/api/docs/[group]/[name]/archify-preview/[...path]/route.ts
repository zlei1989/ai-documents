import { getArchifyPreviewHtml, resolveStorageRoot } from '@aidocs/api';
import { route } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string; path: string[] }>;
}

/** GET：读取实时预览缓存，仍走 sandbox CSP */
export async function GET(_request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name, path } = await context.params;
    const preview = getArchifyPreviewHtml(resolveStorageRoot(), group, name, path.join('/'));
    return new Response(preview.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; frame-ancestors 'self'",
      },
    });
  })();
}
