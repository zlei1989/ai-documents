/**
 * 把文档/消息里的图片写进系统剪贴板（PNG）。
 *
 * 浏览器剪贴板只接受位图，SVG 海报必须先栅格化；canvas 读取跨源图片会污染画布，
 * 所以统一先 fetch 成 Blob、再用 object URL 解码。`navigator.clipboard.write`
 * 需要在用户手势里同步发起，这里把栅格化 Promise 直接交给 ClipboardItem，
 * 让写入在点击手势内开始、等图片就绪后再落剪贴板。
 */

/** 剪贴板位图长边上限：2 倍导出足够清晰，也不至于让 4K 海报写爆剪贴板 */
const MAX_EDGE = 4096;
/** 矢量图按 2 倍栅格化，位图保持原始像素、不放大 */
const VECTOR_SCALE = 2;

export interface RasterizeOptions {
  /** 长边像素上限，默认 4096 */
  maxEdge?: number;
}

/** 从 SVG 源码读固有尺寸：先 width/height，再退回 viewBox */
export function parseSvgSize(svg: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const width = toPx(readAttribute(tag, 'width'));
  const height = toPx(readAttribute(tag, 'height'));
  if (width && height) return { width, height };
  const viewBox = readAttribute(tag, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4) {
    const boxWidth = viewBox[2];
    const boxHeight = viewBox[3];
    if (boxWidth && boxHeight && boxWidth > 0 && boxHeight > 0) {
      return { width: boxWidth, height: boxHeight };
    }
  }
  return null;
}

/** 目标画布缩放：矢量图 2x、位图 1x，长边一律不超过 maxEdge */
export function rasterScale(width: number, height: number, vector: boolean, maxEdge = MAX_EDGE): number {
  const longest = Math.max(width, height);
  if (!(longest > 0) || !(maxEdge > 0)) return 1;
  return Math.min(vector ? VECTOR_SCALE : 1, maxEdge / longest);
}

/** 当前浏览器是否能写图片剪贴板（Firefox / 老 Safari 会缺 ClipboardItem） */
export function canCopyImageToClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  );
}

/**
 * 复制一张同源图片到剪贴板。URL 与页面里 <img> 用的一致（含破缓存版本号）。
 * 失败时抛出面向用户的中文错误，由调用方决定 toast 文案。
 */
export async function copyImageToClipboard(url: string, options: RasterizeOptions = {}): Promise<void> {
  if (!canCopyImageToClipboard()) {
    throw new Error('当前浏览器不支持复制图片，请改用「在新标签打开」后另存');
  }
  const png = imageUrlToPng(url, options);
  // ClipboardItem 会消费这个 Promise；再挂一个空 catch，避免 write 提前失败时冒出未处理拒绝
  void png.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      throw new Error('浏览器拒绝了剪贴板写入，请让页面保持聚焦后重试');
    }
    throw error;
  }
}

/** URL → PNG Blob：fetch 保证同源、canvas 不被污染 */
async function imageUrlToPng(url: string, options: RasterizeOptions): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`图片加载失败（HTTP ${response.status}）`);
  const source = await response.blob();
  if (!source.size) throw new Error('图片内容为空');
  return rasterizeToPng(source, url, options);
}

/** 把图片 Blob 栅格化成 PNG；SVG 用源码里的尺寸，避免 naturalWidth 退化成 300×150 */
async function rasterizeToPng(
  source: Blob,
  name: string,
  options: RasterizeOptions = {},
): Promise<Blob> {
  const vector = source.type === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(name);
  const svgText = vector ? await source.text() : null;
  const objectUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();

    const measured = svgText ? parseSvgSize(svgText) : null;
    const width = measured?.width ?? image.naturalWidth;
    const height = measured?.height ?? image.naturalHeight;
    if (!(width > 0) || !(height > 0)) throw new Error('无法读取图片尺寸');

    const scale = rasterScale(width, height, vector, options.maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持 Canvas，无法转换图片');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('图片转换为 PNG 失败');
    return png;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function readAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? null;
}

/** 只认无单位或 px 的正数；百分比/em 等交给 viewBox 兜底 */
function toPx(value: string | null): number | null {
  const match = value?.match(/^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
