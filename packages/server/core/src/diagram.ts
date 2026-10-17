import { isAbsolute } from 'node:path';

/** 文档目录内的资源约定：所有图片/附件都在 assets/ 下，图示默认在 assets/diagrams/。 */
export const ASSETS_ROOT = 'assets';
export const DIAGRAMS_DIR = 'assets/diagrams';

/** 单个资源的读取上限（图片/附件） */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export interface AssetContentType {
  type: string;
  /** true = 可内联给 <img> / 浏览器渲染；false = 一律 attachment，避免 HTML 等被当页面执行 */
  inline: boolean;
}

const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

export function assetExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function assetContentType(path: string): AssetContentType {
  const type = IMAGE_TYPES[assetExtension(path)];
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

function assertSegment(segment: string, kind: string): void {
  if (!segment) throw new Error(`${kind}不合法：存在空路径段`);
  if (segment === '.' || segment === '..') throw new Error(`${kind}不合法：不允许 . 或 .. 路径段`);
  if (segment.startsWith('.')) throw new Error(`${kind}不合法：不允许隐藏文件或目录（${segment}）`);
  if (/[/\\\u0000-\u001f]/.test(segment)) throw new Error(`${kind}不合法：包含路径分隔符或控制字符`);
}

/** 相对 assets/ 的路径（正斜杠）；供 API 路由使用。 */
export function normalizeAssetRelativePath(input: string, kind = '资源路径'): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error(`${kind}不能为空`);
  if (isAbsolute(raw)) throw new Error(`${kind}必须是相对路径`);
  if (raw.includes('\\')) throw new Error(`${kind}不能包含反斜杠`);
  if (raw.startsWith('/')) throw new Error(`${kind}不能以 / 开头`);
  const segments = raw.split('/');
  for (const segment of segments) assertSegment(segment, kind);
  return segments.join('/');
}

/** 完整资源路径（相对文档目录，例如 assets/diagrams/x.svg）。 */
export function normalizeAssetPath(input: string, kind = '资源路径'): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error(`${kind}不能为空`);
  const rel = raw.startsWith(`${ASSETS_ROOT}/`) ? raw.slice(ASSETS_ROOT.length + 1) : null;
  if (rel === null) throw new Error(`${kind}必须以 ${ASSETS_ROOT}/ 开头（例如 ${DIAGRAMS_DIR}/x.svg）`);
  return `${ASSETS_ROOT}/${normalizeAssetRelativePath(rel, kind)}`;
}

/** assets/ 前缀的完整路径 → 相对 assets/ 的路径；不合法返回 null */
export function assetRelativeOrNull(path: string): string | null {
  if (!path.startsWith(`${ASSETS_ROOT}/`)) return null;
  try {
    return normalizeAssetRelativePath(path.slice(ASSETS_ROOT.length + 1));
  } catch {
    return null;
  }
}

/** 中文/字母/数字/下划线/连字符保留，其余折叠为 -；用于新图示文件名。 */
export function diagramSlug(title: string): string {
  return fileSlug(title, '图示');
}

/** 生图文件名 slug：规则同 diagramSlug，fallback 为「图片」。 */
export function assetSlug(title: string): string {
  return fileSlug(title, '图片');
}

function fileSlug(title: string, fallback: string): string {
  const normalized = (title || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 60)
    .replace(/[.\-]+$/g, '');
  return normalized || fallback;
}

/** Markdown alt 文本安全化：方括号会破坏 ![alt](path) 语法。 */
export function safeMarkdownAlt(text: string): string {
  const alt = (text || '')
    .replace(/\s+/g, ' ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .trim();
  return alt || '图示';
}

/** 生成标准 Markdown 图片引用；path 为相对文档目录的完整资源路径。 */
export function diagramMarkdownRef(alt: string, path: string): string {
  return `![${safeMarkdownAlt(alt)}](${path})`;
}

