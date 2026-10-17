import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GeneratedImagesBlock } from '@aidocs/ui';

function render(block: { kind: 'images'; images: { path: string; alt: string; size?: string }[] }) {
  return renderToStaticMarkup(
    createElement(GeneratedImagesBlock, {
      block,
      resolveImageUrl: (path: string) => `/api/docs/jw/x/${path}`,
    }),
  );
}

describe('GeneratedImagesBlock', () => {
  it('多图拼格子：每张图有代理地址、alt、尺寸角标与提示', () => {
    const html = render({
      kind: 'images',
      images: [
        { path: 'assets/images/a.jpg', alt: '城市夜景 第 1 张', size: '2048x2048' },
        { path: 'assets/images/b.jpg', alt: '城市夜景 第 2 张', size: '2048x2048' },
        { path: 'assets/images/c.jpg', alt: '城市夜景 第 3 张', size: '2048x2048' },
      ],
    });
    expect(html).toContain('生成结果 · 3 张');
    expect(html).toContain('点击放大 · 右键加入上下文');
    expect((html.match(/<img/g) ?? []).length).toBe(3);
    expect(html).toContain('src="/api/docs/jw/x/assets/images/a.jpg"');
    expect(html).toContain('alt="城市夜景 第 1 张"');
    expect(html).toContain('2048x2048');
    expect(html).toContain('repeat(3, minmax(0, 1fr))');
  });

  it('单图使用大图布局', () => {
    const html = render({
      kind: 'images',
      images: [{ path: 'assets/images/only.jpg', alt: '只有一张', size: '1024x1024' }],
    });
    expect(html).toContain('生成结果 · 1 张');
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(html).toContain('max-h-64');
    expect(html).not.toContain('repeat(');
  });

  it('解析不到地址时显示路径占位，不渲染 img', () => {
    const html = renderToStaticMarkup(
      createElement(GeneratedImagesBlock, {
        block: { kind: 'images', images: [{ path: 'assets/images/missing.jpg', alt: '' }] },
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('assets/images/missing.jpg');
    expect(html).toContain('本地图片');
  });
});
