import { openPrintWindow } from './print-window';

/**
 * 文章打印样式。正文自身带 Tailwind 类，所以先复制当前页面的样式表，
 * 再追加这一层打印专用规则：A4 页边距、图片/表格不跨页、标题不与正文分离。
 */
const PRINT_STYLE = `
  @page { margin: 14mm; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-article { width: 100% !important; max-width: 820px !important; margin: 0 auto !important; padding: 0 16px !important; box-sizing: border-box; }
  .print-article img { max-width: 100% !important; height: auto !important; break-inside: avoid; page-break-inside: avoid; }
  .print-article figure { break-inside: avoid; page-break-inside: avoid; }
  .print-article h1, .print-article h2, .print-article h3, .print-article h4 {
    break-after: avoid; page-break-after: avoid;
  }
  .print-article table { width: 100% !important; border-collapse: collapse; font-size: 12px; }
  .print-article th, .print-article td {
    border: 1px solid #d4d4d8 !important; padding: 4px 6px !important; vertical-align: top;
  }
  .print-article pre { white-space: pre-wrap !important; word-break: break-word; }
  .print-article blockquote { border-left: 3px solid #d4d4d8 !important; padding-left: 12px !important; color: #52525b !important; }
  .print-article a { color: inherit !important; text-decoration: none !important; }
  @media print {
    .print-article { max-width: none !important; padding: 0 !important; font-size: 10.5pt !important; line-height: 1.7 !important; }
  }
`;

export interface ArticlePrintDocument {
  title: string;
  head: string;
  body: string;
}

/**
 * 从已渲染的正文节点克隆打印文档。
 * - 图片改成 eager 并绝对化地址：打印窗口里没有滚动，懒加载图会空白；
 * - 复制主文档的 `<link rel=stylesheet>` 与 `<style>`，让 Tailwind 类继续生效。
 */
export function buildArticlePrintDocument(source: HTMLElement, title: string): ArticlePrintDocument {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add('print-article');
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    img.loading = 'eager';
    img.decoding = 'sync';
    const src = img.getAttribute('src');
    if (src) img.src = new URL(src, window.location.href).href;
  }
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((element) => element.outerHTML)
    .join('\n');
  return { title, head: `${styles}\n<style>${PRINT_STYLE}</style>`, body: clone.outerHTML };
}

/** 打印整篇文章：克隆当前预览节点到独立窗口，等图片/样式加载完成后调起系统打印 */
export function printArticle(source: HTMLElement, title: string): boolean {
  const output = buildArticlePrintDocument(source, title);
  const win = openPrintWindow(output.title, output.body, output.head);
  if (!win) return false;
  printWhenReady(win);
  return true;
}

/** 等资源加载完成再打印；兜底超时避免某张图失败导致永远不出打印框 */
function printWhenReady(win: Window): void {
  let printed = false;
  const trigger = () => {
    if (printed) return;
    printed = true;
    try {
      win.focus();
      win.print();
    } catch {
      win.close();
    }
  };
  const wait = () => win.setTimeout(trigger, 120);
  if (win.document.readyState === 'complete') wait();
  else win.addEventListener('load', wait, { once: true });
  win.setTimeout(trigger, 4000);
}
