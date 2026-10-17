import { getArchifyView, resolveStorageRoot } from '@aidocs/api';
import { route } from '../../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string; path: string[] }>;
}

/**
 * 交互版 HTML：只允许从 .archify.json 派生，返回沙箱 CSP。
 * iframe 端再加 sandbox="allow-scripts"；不授予 same-origin。
 */
export async function GET(_request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name, path } = await context.params;
    const view = await getArchifyView(resolveStorageRoot(), group, name, path.join('/'));
    return new Response(view.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(view.stale ? { 'X-Archify-Stale': '1' } : {}),
        'Content-Security-Policy':
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; frame-ancestors 'self'",
      },
    });
  })(_request, context);
}
