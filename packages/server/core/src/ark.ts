/**
 * 火山方舟数据面 API 的 Base URL 规整。
 *
 * 用户可能只填域名，也可能填到 `/api/v3`；只填域名时自动补 `/api/v3`。
 * 图片生成与 Files API 共用这一套规则。
 */
export function arkApiBase(baseUrl: string): string {
  const raw = (baseUrl || '').trim();
  if (!raw) throw new Error('Base URL 不能为空');
  const base = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Base URL 不合法：${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 只支持 http/https');
  }
  if (parsed.username || parsed.password) throw new Error('Base URL 不能携带用户名或密码');
  if (parsed.search || parsed.hash) throw new Error('Base URL 不能带查询串或锚点');
  const path = parsed.pathname.replace(/\/+$/, '');
  return path ? base : `${base}/api/v3`;
}

/** `{arkApiBase(baseUrl)} + path`；path 以 / 开头或自动补 */
export function arkApiUrl(baseUrl: string, path: string): string {
  const base = arkApiBase(baseUrl);
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
