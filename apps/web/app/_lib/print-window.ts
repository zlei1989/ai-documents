/** 打印窗口的公共工具：新建一个同源 about:blank 窗口并写入 HTML。 */

export function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

/**
 * 打开只读打印窗口。about:blank 会继承打开者的 origin 与 base URL，
 * 因此 `/_next/...css`、`/api/...svg` 这类相对地址可以直接加载。
 * 返回 null 表示弹窗被浏览器拦截。
 */
export function openPrintWindow(title: string, bodyHtml: string, headHtml = ''): Window | null {
  const win = window.open('', '_blank', 'popup=yes,width=1024,height=768');
  if (!win) return null;
  const doc = win.document;
  doc.open();
  doc.write(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
${headHtml}
</head>
<body>${bodyHtml}</body>
</html>`);
  doc.close();
  return win;
}
