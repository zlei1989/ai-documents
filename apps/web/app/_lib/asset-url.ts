/**
 * 文档内图片的 URL/路径工具。
 *
 * MAIN.md 里写的是标准相对路径（assets/diagrams/x.svg），App 渲染时才映射到
 * `/api/docs/<group>/<name>/assets/...`；磁盘上的 Markdown 保持可被任何编辑器打开。
 */

export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** 文档 API 根：/api/docs/<group>/<name> */
export function docBase(group: string, name: string): string {
  return `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
}

/** 文档文件夹树：/api/docs/<group>/<name>/files */
export function docFilesUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/files`;
}

/** 单个文件预览（文本/Markdown 元信息）：/files/content?path=… */
export function docFileContentUrl(base: string, path: string): string {
  return `${docFilesUrl(base)}/content?path=${encodeURIComponent(path)}`;
}

/** 原始文件：/files/raw?path=…；version 用于破图片缓存 */
export function docFileRawUrl(base: string, path: string, version?: string | number): string {
  const url = `${docFilesUrl(base)}/raw?path=${encodeURIComponent(path)}`;
  if (version === undefined || version === null || version === '') return url;
  return `${url}&v=${encodeURIComponent(String(version))}`;
}

/** 只接受 assets/ 下的相对路径；拒绝外部、data:、穿越、隐藏段、查询/锚点 */
export function normalizeAssetPath(input: string): string | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  if (/^(?:https?:|data:|file:|javascript:)/i.test(raw)) return null;
  if (raw.startsWith('/') || raw.includes('\\')) return null;
  const clean = raw.startsWith('./') ? raw.slice(2) : raw;
  if (!clean.startsWith('assets/')) return null;
  if (/[\s()?#]/.test(clean)) return null;
  const segments = clean.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) return null;
  return segments.join('/');
}

/** 图片 URL；version 变化时用于破缓存（?v=…） */
export function assetUrl(base: string, path: string, version?: number | string): string {
  const url = `${base.replace(/\/$/, '')}/${encodePath(path)}`;
  if (version === undefined || version === null || version === '') return url;
  return `${url}?v=${encodeURIComponent(String(version))}`;
}

/** 安全的 Markdown alt：方括号会破坏语法 */
export function safeMarkdownAlt(text: string): string {
  const alt = (text || '')
    .replace(/\s+/g, ' ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .trim();
  return alt || '图示';
}

export function diagramMarkdownRef(alt: string, path: string): string {
  return `![${safeMarkdownAlt(alt)}](${path})`;
}

/** Archify 源 JSON 的读写 API（path 为 assets/ 下的完整路径） */
export function archifyApiUrl(base: string, sourcePath: string): string {
  return `${base.replace(/\/$/, '')}/archify/${encodePath(sourcePath)}`;
}

/** 海报路径 → 源 IR 路径：x.archify.svg 由 x.archify.json 渲染 */
export function archifySourcePath(posterPath: string): string {
  return posterPath.replace(/\.archify\.svg$/i, '.archify.json');
}

/** 交互 viewer URL；embed=1 用于编辑器内嵌，version 用于破缓存 */
export function archifyViewUrl(base: string, sourcePath: string, version?: string, embed = true): string {
  const params = new URLSearchParams();
  if (version) params.set('v', version);
  if (embed) params.set('embed', '1');
  params.set('theme', 'light');
  return `${base.replace(/\/$/, '')}/archify-view/${encodePath(sourcePath)}?${params.toString()}`;
}

/**
 * 海报在新标签页打开的交互 viewer：不带 embed，保留 Archify 自带的工具栏/侧栏。
 * 海报只读，交互能力全部来自 viewer。
 */
export function archifyPosterViewUrl(base: string, posterPath: string, version?: string): string {
  return archifyViewUrl(base, archifySourcePath(posterPath), version, false);
}

export function archifyValidateUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/archify-validate`;
}

export function archifyLayoutUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/archify-layout`;
}

/** 编辑器里的 AI 改图 / 校验失败自动修复（直接调 pi 模型，结构化结果） */
export function archifyAiUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/archify-ai`;
}
