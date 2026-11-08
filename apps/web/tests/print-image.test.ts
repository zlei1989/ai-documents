import { afterEach, describe, expect, it, vi } from 'vitest';
import { printImage } from '../app/_lib/print-image';

interface FakeImage {
  complete: boolean;
  naturalWidth: number;
  addEventListener: ReturnType<typeof vi.fn>;
}

function fakeWindow(image: FakeImage | null) {
  const write = vi.fn();
  const document = {
    open: vi.fn(),
    write,
    close: vi.fn(),
    querySelector: vi.fn(() => image),
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
  };
  return { win, document, write };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('printImage', () => {
  it('新窗口只放这张图，图片就绪后调起打印', () => {
    const { win, write } = fakeWindow({ complete: true, naturalWidth: 1200, addEventListener: vi.fn() });
    const open = vi.fn(() => win);
    vi.stubGlobal('window', { open });

    expect(printImage('/api/docs/a/assets/diagrams/x.archify.svg', '贾府世系图：宁荣两府四代')).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank', expect.stringContaining('popup'));
    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain('src="/api/docs/a/assets/diagrams/x.archify.svg"');
    expect(html).toContain('<figcaption>贾府世系图：宁荣两府四代</figcaption>');
    expect(html).toContain('@media print');
    expect(win.print).toHaveBeenCalledTimes(1);
  });

  it('图片还没加载完时等 load 事件再打印', () => {
    const image: FakeImage = { complete: false, naturalWidth: 0, addEventListener: vi.fn() };
    const { win } = fakeWindow(image);
    vi.stubGlobal('window', { open: () => win });

    printImage('/api/x.svg', '');
    expect(win.print).not.toHaveBeenCalled();

    const [event, handler] = image.addEventListener.mock.calls[0] as [string, () => void];
    expect(event).toBe('load');
    handler();
    expect(win.print).toHaveBeenCalledTimes(1);
  });

  it('图题与地址写入 HTML 前转义', () => {
    const { win, write } = fakeWindow({ complete: true, naturalWidth: 10, addEventListener: vi.fn() });
    vi.stubGlobal('window', { open: () => win });

    printImage('/api/x.svg?a=1&b=2', '<图> & "引号"');
    const html = write.mock.calls[0]?.[0] as string;
    expect(html).toContain('&lt;图&gt; &amp; &quot;引号&quot;');
    expect(html).toContain('src="/api/x.svg?a=1&amp;b=2"');
    expect(html).not.toContain('<图>');
  });

  it('弹窗被拦截时返回 false', () => {
    vi.stubGlobal('window', { open: () => null });
    expect(printImage('/api/x.svg', '图')).toBe(false);
  });

  it('图片加载失败时关闭打印窗口，不弹空页', () => {
    const { win } = fakeWindow({ complete: true, naturalWidth: 0, addEventListener: vi.fn() });
    vi.stubGlobal('window', { open: () => win });

    expect(printImage('/api/missing.svg', '图')).toBe(true);
    expect(win.print).not.toHaveBeenCalled();
    expect(win.close).toHaveBeenCalledTimes(1);
  });
});
