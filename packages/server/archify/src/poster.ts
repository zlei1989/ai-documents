import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { ArchifyError } from './types';

/**
 * Archify HTML → 可独立 <img> 加载的 SVG 海报。
 *
 * Archify 的 SVG 依赖 HTML viewer 的 CSS class/变量；这里把页面全部 <style>
 * 内嵌进 SVG，固定 light 主题、去掉动画，再按安全子集移除脚本/外链。
 * 海报只读；它的职责是标准 Markdown 展示与交互入口。
 */

export const ARCHIFY_POSTER_MAX_BYTES = 768 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';

const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'animate',
  'animatetransform',
  'animatemotion',
  'set',
]);

type AnyElement = {
  nodeType: number;
  localName?: string | null;
  nodeName: string;
  childNodes: { length: number; item(index: number): AnyElement | null };
  attributes: { length: number; item(index: number): { name: string; value: string } | null } | null;
  parentNode: AnyElement | null;
  textContent: string | null;
  removeChild(child: AnyElement): AnyElement;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  insertBefore(newNode: AnyElement, ref: AnyElement | null): AnyElement;
  appendChild(newNode: AnyElement): AnyElement;
  firstChild: AnyElement | null;
};

function findMainSvg(html: string): { start: number; end: number } {
  const candidates: number[] = [];
  let index = html.indexOf('<svg');
  while (index >= 0) {
    candidates.push(index);
    index = html.indexOf('<svg', index + 4);
  }
  if (candidates.length === 0) throw new ArchifyError('Archify HTML 中没有找到 <svg>', { stage: 'extract' });
  const chosen =
    candidates.find((start) => {
      const head = html.slice(start, html.indexOf('>', start) + 1);
      return head.includes('archify-diagram-title') || head.includes('data-node-ui');
    }) ?? candidates[0]!;
  const end = html.indexOf('</svg>', chosen);
  if (end < 0) throw new ArchifyError('Archify HTML 的主 SVG 未闭合', { stage: 'extract' });
  return { start: chosen, end: end + '</svg>'.length };
}

function extractStyleBlocks(html: string): string {
  const blocks: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) blocks.push(match[1] ?? '');
  return blocks.join('\n');
}

function stripDangerousCss(css: string): string {
  const withoutImports = css.replace(/@import\s+[^;]+;/gi, '');
  if (/url\s*\(\s*['"]?\s*(?:https?:)?\/\//i.test(withoutImports) || /javascript\s*:/i.test(withoutImports)) {
    throw new ArchifyError('Archify 海报 CSS 含外部资源引用，已拒绝生成', { stage: 'extract' });
  }
  return withoutImports;
}

function splitViewBox(value: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts as [number, number, number, number];
}

function cleanElementTree(root: AnyElement): string[] {
  const warnings: string[] = [];
  const stack: AnyElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element) continue;
    if (element.nodeType === 8 || element.nodeType === 7) {
      element.parentNode?.removeChild(element);
      continue;
    }
    if (element.nodeType !== 1) continue;
    const tag = (element.localName || element.nodeName || '').toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      warnings.push(`已移除 <${tag}>`);
      element.parentNode?.removeChild(element);
      continue;
    }
    const attrs = element.attributes;
    if (attrs) {
      const remove: string[] = [];
      for (let i = 0; i < attrs.length; i += 1) {
        const attr = attrs.item(i);
        if (!attr) continue;
        const name = attr.name;
        const lower = name.toLowerCase();
        if (lower.startsWith('on')) remove.push(name);
        else if (lower === 'href' || lower === 'xlink:href') {
          if (!attr.value.trim().startsWith('#')) remove.push(name);
        } else if (/javascript\s*:/i.test(attr.value)) remove.push(name);
        else if (lower === 'style' && /(?:url\s*\(\s*['"]?\s*(?:https?:)?\/\/|@import)/i.test(attr.value)) remove.push(name);
      }
      for (const name of remove) element.removeAttribute(name);
    }
    if (tag === 'svg' && element === root) {
      element.setAttribute('data-theme', 'light');
      element.removeAttribute('data-animation');
      const vb = splitViewBox(element.getAttribute('viewBox'));
      if (vb) {
        element.setAttribute('width', String(vb[2]));
        element.setAttribute('height', String(vb[3]));
      }
      if (!element.getAttribute('xmlns')) element.setAttribute('xmlns', SVG_NS);
    }
    // 移除动画/阅读器状态，避免在 <img> 中运动
    if (element.getAttribute('data-animate') !== null) element.removeAttribute('data-animate');
    for (const name of ['data-reader-fit', 'data-reader-min-text', 'data-reader-primary-text']) {
      if (element.getAttribute(name) !== null) element.removeAttribute(name);
    }
    const children: AnyElement[] = [];
    for (let i = 0; i < element.childNodes.length; i += 1) {
      const child = element.childNodes.item(i);
      if (child) children.push(child);
    }
    for (const child of children) {
      const type = child.nodeType;
      if (type === 1 || type === 8 || type === 7) stack.push(child);
    }
  }
  return warnings;
}

function createStyleElement(doc: ReturnType<DOMParser['parseFromString']>, css: string): AnyElement {
  const style = doc.createElementNS(SVG_NS, 'style');
  style.textContent = css;
  return style as unknown as AnyElement;
}

/** 从 Archify 渲染的 HTML 生成独立 SVG；失败抛 ArchifyError */
export function extractArchifyPoster(html: string): { svg: string; warnings: string[] } {
  const { start, end } = findMainSvg(html);
  const rawSvg = html.slice(start, end);
  const css = stripDangerousCss(extractStyleBlocks(html));
  const first = renderPoster(rawSvg, css);
  if (Buffer.byteLength(first.svg, 'utf8') <= ARCHIFY_POSTER_MAX_BYTES) return first;

  // 字体 CSS 通常是最大头；去掉 @font-face，系统字体回退。
  const leanCss = css.replace(/@font-face\s*\{[\s\S]*?\}\s*/gi, '');
  const lean = renderPoster(rawSvg, leanCss);
  if (Buffer.byteLength(lean.svg, 'utf8') <= ARCHIFY_POSTER_MAX_BYTES) {
    return { svg: lean.svg, warnings: [...first.warnings, '海报超过限额，已移除外嵌字体 CSS'] };
  }
  throw new ArchifyError(
    `Archify 海报过大（${Math.round(Buffer.byteLength(first.svg, 'utf8') / 1024)}KB，上限 ${ARCHIFY_POSTER_MAX_BYTES / 1024}KB）`,
    { stage: 'extract', warnings: first.warnings },
  );
}

function renderPoster(rawSvg: string, css: string): { svg: string; warnings: string[] } {
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level === 'fatalError') throw new Error(message);
      },
    }).parseFromString(rawSvg, 'image/svg+xml');
  } catch (error) {
    throw new ArchifyError(`Archify 主 SVG 解析失败：${(error as Error).message}`, { stage: 'extract' });
  }
  const root = doc.documentElement as unknown as AnyElement | null;
  if (!root) throw new ArchifyError('Archify 主 SVG 缺少根元素', { stage: 'extract' });
  const warnings = cleanElementTree(root);
  if (css.trim()) root.insertBefore(createStyleElement(doc, css), root.firstChild);
  try {
    const svg = new XMLSerializer().serializeToString(doc as never, { requireWellFormed: true });
    return { svg, warnings };
  } catch (error) {
    throw new ArchifyError(`Archify 海报序列化失败：${(error as Error).message}`, { stage: 'extract' });
  }
}

/**
 * 服务端读取海报时的二次安全净化：允许 class/style/defs，但禁脚本/事件/外链。
 * 不使用旧的 SVG 编辑器白名单（那会剥掉 Archify 的 CSS）。
 */
export function sanitizeArchifyPoster(source: string): { svg: string; warnings: string[] } {
  if (Buffer.byteLength(source, 'utf8') > ARCHIFY_POSTER_MAX_BYTES) {
    throw new ArchifyError('Archify 海报超过大小上限', { stage: 'extract' });
  }
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level === 'fatalError') throw new Error(message);
      },
    }).parseFromString(source, 'image/svg+xml');
  } catch (error) {
    throw new ArchifyError(`Archify 海报解析失败：${(error as Error).message}`, { stage: 'extract' });
  }
  const root = doc.documentElement as unknown as AnyElement | null;
  if (!root) throw new ArchifyError('Archify 海报缺少根元素', { stage: 'extract' });
  const warnings = cleanElementTree(root);
  for (const style of Array.from({ length: root.childNodes.length }, (_, i) => root.childNodes.item(i))) {
    if (style && (style.localName || style.nodeName).toLowerCase() === 'style') {
      style.textContent = stripDangerousCss(style.textContent ?? '');
    }
  }
  let svg: string;
  try {
    svg = new XMLSerializer().serializeToString(doc as never, { requireWellFormed: true });
  } catch (error) {
    throw new ArchifyError(`Archify 海报序列化失败：${(error as Error).message}`, { stage: 'extract' });
  }
  return { svg, warnings };
}

const BRIDGE_MARKER = 'data-aidocs-archify-bridge';

/**
 * 把“点击节点 → 父窗口选中 / 父窗口 focus → 节点”的桥接脚本注入 viewer HTML。
 * 只使用 data-node-id / postMessage；不改变 Archify 本体。
 */
export function injectArchifyBridge(html: string): string {
  if (html.includes(BRIDGE_MARKER)) return html;
  const script = `<script ${BRIDGE_MARKER}>
(() => {
  const send = (payload) => { try { parent.postMessage(payload, '*'); } catch (_) {} };
  document.addEventListener('click', (event) => {
    const target = event.target;
    const element = target && target.closest ? target.closest('[data-node-id]') : null;
    if (!element) return;
    const id = element.getAttribute('data-node-id');
    if (id) send({ source: 'aidocs-archify', type: 'select', id });
  }, true);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'aidocs' || data.type !== 'focus' || typeof data.id !== 'string') return;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(data.id)) return;
    const escaped = window.CSS && CSS.escape ? CSS.escape(data.id) : data.id;
    const element = document.querySelector('[data-node-id="' + escaped + '"]');
    if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
})();
</script>`;
  const index = html.lastIndexOf('</body>');
  if (index < 0) return `${html}\n${script}`;
  return `${html.slice(0, index)}${script}\n${html.slice(index)}`;
}
