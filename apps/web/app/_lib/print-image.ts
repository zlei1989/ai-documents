import { escapeHtml, openPrintWindow } from './print-window';

const PRINT_STYLE = `
  @page { margin: 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
  figure { margin: 0; max-width: 100%; text-align: center; }
  img { display: block; width: auto; height: auto; max-width: 100%; max-height: calc(100vh - 32px); margin: 0 auto; }
  figcaption { margin-top: 10px; font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #71717a; }
  @media print {
    body { min-height: auto; padding: 0; display: block; }
    img { width: 100%; max-height: none; }
  }
`;

/**
 * 打印单张图片：新开一个只放这张图的白底窗口，图片加载完再调起系统打印。
 *
 * 为什么不用隐藏 iframe：部分浏览器对 `display:none` / 零尺寸 iframe 的打印支持不稳定；
 * 由用户点击（右键菜单项）触发的 `window.open` 通常不会被拦截。被拦截时返回 false，
 * 调用方负责提示用户允许弹窗。
 */
export function printImage(url: string, alt = ''): boolean {
  if (!url) return false;
  const title = alt.trim() || '打印图片';
  const caption = alt.trim() ? `<figcaption>${escapeHtml(alt.trim())}</figcaption>` : '';
  const win = openPrintWindow(
    title,
    `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />${caption}</figure>`,
    `<style>${PRINT_STYLE}</style>`,
  );
  if (!win) return false;

  const doc = win.document;
  const trigger = () => {
    win.focus();
    win.print();
  };
  const img = doc.querySelector('img');
  if (!img) {
    win.setTimeout(trigger, 100);
    return true;
  }
  if (img.complete) {
    if (img.naturalWidth === 0) {
      win.close();
      return true;
    }
    win.setTimeout(trigger, 80);
  } else {
    img.addEventListener('load', () => win.setTimeout(trigger, 80), { once: true });
    img.addEventListener('error', () => win.close(), { once: true });
  }
  return true;
}
