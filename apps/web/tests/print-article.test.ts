import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArticlePrintDocument, printArticle } from '../app/_lib/print-article';

interface FakeImage {
  loading: string;
  decoding: string;
  src: string;
  getAttribute: (name: string) => string | null;
}

function fakeWindow() {
  const write = vi.fn();
  const document = {
    open: vi.fn(),
    write,
    close: vi.fn(),
    readyState: 'complete',
    querySelectorAll: vi.fn(),
  };
  const win = {
    document,
    setTimeout: (handler: () => void) => {
      handler();
      return 0;
    },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
  };
  return { win, document, write };
}

const SOURCE_URL = '/api/docs/g/n/assets/diagrams/x.archify.svg';

function fakeSource(image: FakeImage) {
  const clone = {
    classList: { add: vi.fn() },
    querySelectorAll: vi.fn(() => [image]),
    outerHTML: '<article>正文内容</article>',
  };
  return { source: { cloneNode: vi.fn(() => clone) } as unknown as HTMLElement, clone };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('printArticle', () => {
  it('克隆正文、绝对化图片、保留样式后调起打印', () => {
    const image: FakeImage = {
      loading: 'lazy',
      decoding: 'async',
      src: SOURCE_URL,
      getAttribute: () => SOURCE_URL,
    };
    const { source, clone } = fakeSource(image);
    const { win, write } = fakeWindow();
    vi.stubGlobal('window', { open: () => win, location: { href: 'http://localhost:3084/workspace/g/n' } });
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => [{ outerHTML: '<link rel="stylesheet" href="/_next/app.css">' }]),
    });

    expect(printArticle(source, 'g / n')).toBe(true);

    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain('<title>g / n</title>');
    expect(html).toContain('<link rel="stylesheet" href="/_next/app.css">');
    expect(html).toContain('@page');
    expect(html).toContain('<article>正文内容</article>');
    expect(clone.classList.add).toHaveBeenCalledWith('print-article');
    expect(image.loading).toBe('eager');
    expect(image.decoding).toBe('sync');
    expect(image.src).toBe(`http://localhost:3084${SOURCE_URL}`);
    expect(win.print).toHaveBeenCalledTimes(1);
  });

  it('打印文档带页边距与分页保护', () => {
    const image: FakeImage = { loading: 'lazy', decoding: 'async', src: '/a.png', getAttribute: () => '/a.png' };
    const { source } = fakeSource(image);
    vi.stubGlobal('window', { open: () => fakeWindow().win, location: { href: 'http://localhost:3084/' } });
    vi.stubGlobal('document', { querySelectorAll: vi.fn(() => []) });

    const output = buildArticlePrintDocument(source, '标题');
    expect(output.body).toContain('<article>正文内容</article>');
    expect(output.head).toContain('@page { margin: 14mm; }');
    expect(output.head).toContain('break-after: avoid');
    expect(output.head).toContain('.print-article table');
  });

  it('标题里的 HTML 被转义', () => {
    const image: FakeImage = { loading: 'lazy', decoding: 'async', src: '/a.png', getAttribute: () => '/a.png' };
    const { source } = fakeSource(image);
    const { win, write } = fakeWindow();
    vi.stubGlobal('window', { open: () => win, location: { href: 'http://localhost:3084/' } });
    vi.stubGlobal('document', { querySelectorAll: vi.fn(() => []) });

    printArticle(source, '<b>&');
    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain('<title>&lt;b&gt;&amp;</title>');
  });

  it('弹窗被拦截时返回 false', () => {
    const image: FakeImage = { loading: 'lazy', decoding: 'async', src: '/a.png', getAttribute: () => '/a.png' };
    const { source } = fakeSource(image);
    vi.stubGlobal('window', { open: () => null, location: { href: 'http://localhost:3084/' } });
    vi.stubGlobal('document', { querySelectorAll: vi.fn(() => []) });

    expect(printArticle(source, '标题')).toBe(false);
  });
});
