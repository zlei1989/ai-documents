import type { RawAsset } from '@aidocs/api';

/**
 * 原始文件响应的公共头：assets 与文档文件夹的 files/raw 共用。
 * SVG 直接导航时也不能执行脚本/拉外部资源；<img> 渲染本身已不受脚本影响。
 */
const BASE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'none'; object-src 'none'; base-uri 'none'",
};

function contentDisposition(filename: string, inline: boolean): string {
  const encoded = encodeURIComponent(filename);
  return inline ? 'inline' : `attachment; filename*=UTF-8''${encoded}`;
}

/** 原始文件响应头（Content-Type / ETag / Last-Modified / 附件名） */
export function rawAssetHeaders(asset: RawAsset): Record<string, string> {
  return {
    ...BASE_HEADERS,
    'Content-Type': asset.contentType,
    'Content-Length': String(asset.size),
    'Last-Modified': asset.lastModified,
    ETag: asset.etag,
    'Content-Disposition': contentDisposition(asset.filename, asset.inline),
  };
}

/** If-None-Match 命中时返回 304（不读 body） */
export function isNotModified(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (!ifNoneMatch) return false;
  return ifNoneMatch === '*' || ifNoneMatch.split(',').map((part) => part.trim()).includes(etag);
}
