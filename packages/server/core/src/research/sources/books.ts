import { cleanText, encodeQuery, getJson, truncate } from '../http';
import type { ResearchSource, SourceHit, SourceSearchOutput } from '../types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitOf(limit: number): number {
  return Math.min(10, Math.max(1, limit));
}

/** Project Gutenberg：公版书（可拿到全文下载链接） */
export const gutenbergSource: ResearchSource = {
  id: 'gutenberg',
  label: 'Project Gutenberg 公版书',
  routing: '已进入公有领域的图书（英文为主）、全文下载链接；找原典/经典文本用它，在版书拿不到',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const json = asRecord(await getJson(`https://gutendex.com/books?search=${encodeQuery(input.query)}`, ctx));
    const total = asNumber(json.count);
    const results = asArray(json.results).slice(0, limitOf(input.limit));
    const hits: SourceHit[] = results.map((raw) => {
      const book = asRecord(raw);
      const id = asNumber(book.id);
      const authors = asArray(book.authors).map((author) => asString(asRecord(author).name));
      const subjects = asArray(book.subjects).map(asString);
      const formats = asRecord(book.formats);
      const plainText =
        asString(formats['text/plain; charset=utf-8']) ||
        asString(formats['text/plain; charset=us-ascii']) ||
        asString(formats['text/plain']);
      const downloads = asNumber(book.download_count);
      return {
        title: cleanText(asString(book.title)) || '（无标题）',
        url: id ? `https://www.gutenberg.org/ebooks/${id}` : '',
        ...(subjects.length > 0 ? { snippet: truncate(subjects.slice(0, 4).join('；'), 200) } : {}),
        meta: [authors.slice(0, 3).join(', '), `下载 ${downloads ?? 0}`, plainText ? '有全文' : '']
          .filter(Boolean)
          .join(' · '),
        ...(plainText ? { fullTextUrl: plainText } : {}),
        ...(id ? { dedupeKey: `gutenberg:${id}` } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url), ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};
