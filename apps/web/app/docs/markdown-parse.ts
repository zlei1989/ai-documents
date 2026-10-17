/**
 * 最小 Markdown 解析（纯函数，便于 node 环境测试）。
 *
 * 在原有标题/段落/列表/引用/代码块之上新增图片块：
 * `![alt](assets/...)` 独占一行时成为独立 block（figure），
 * 行内图片由 renderer 的 renderInline 处理。路径合法性/URL 映射不在解析层做。
 */

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'image'; alt: string; src: string; title?: string }
  | { kind: 'hr' };

export interface ImageToken {
  alt: string;
  src: string;
  title?: string;
}

const IMAGE_LINE =
  /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)\s*$/;

/** 独占一行的图片；不是则返回 null */
export function parseImageLine(line: string): ImageToken | null {
  const match = IMAGE_LINE.exec(line);
  if (!match) return null;
  const alt = match[1] ?? '';
  const src = match[2] ?? '';
  const title = match[3] ?? match[4] ?? '';
  return { alt, src, ...(title ? { title } : {}) };
}

/** 行内图片 token（供 renderer 的 split 正则使用） */
export const INLINE_IMAGE_SOURCE = String.raw`!\[[^\]\n]*\]\([^)\n]+\)`;

export function parseInlineImage(token: string): ImageToken | null {
  const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)$/.exec(token);
  if (!match) return null;
  const alt = match[1] ?? '';
  const src = match[2] ?? '';
  const title = match[3] ?? match[4] ?? '';
  return { alt, src, ...(title ? { title } : {}) };
}

export function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*!\[/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(---|\*\*\*|___)\s*$/.test(line)
  );
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const image = parseImageLine(line);
    if (image) {
      blocks.push({ kind: 'image', ...image });
      i += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, '').trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 跳过结束围栏
      blocks.push({ kind: 'code', lang, code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: (heading[2] ?? '').trim() });
      i += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }

    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (!next.trim() || isBlockStart(next)) break;
      paragraph.push(next);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}
