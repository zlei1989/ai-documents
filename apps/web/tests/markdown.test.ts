import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '../app/docs/markdown';

interface RenderOptions {
  imageVersion?: number | string;
  openArchifyOnClick?: boolean;
}

function render(source: string, options: RenderOptions = {}): string {
  return renderToStaticMarkup(
    createElement(MarkdownPreview, {
      source,
      assetBase: '/api/docs/jw/x',
      ...options,
    }),
  );
}

describe('MarkdownPreview 基础语法', () => {
  it('标题、粗体、斜体、删除线、行内代码', () => {
    const html = render('# 标题\n\n正文 **粗** *斜* ~~删~~ `code`\n');
    expect(html).toContain('<h1 class="mt-6 mb-2 text-2xl font-semibold tracking-tight first:mt-0">标题</h1>');
    expect(html).toContain('<strong class="font-semibold">粗</strong>');
    expect(html).toContain('<em class="italic">斜</em>');
    expect(html).toContain('line-through');
    expect(html).toContain('<code class="rounded bg-zinc-100');
  });

  it('代码块带语言标签，且块内 Markdown 不被解析', () => {
    const html = render('```sh\n![x](assets/a.svg)\nls -la\n```\n');
    expect(html).toContain('>sh</div>');
    expect(html).toContain('![x](assets/a.svg)');
    expect(html).not.toContain('<img');
  });

  it('块引用与分割线', () => {
    const html = render('> 引用\n\n---\n');
    expect(html).toContain('<blockquote');
    expect(html).toContain('引用');
    expect(html).toContain('<hr');
  });

  it('有序列表保留序号', () => {
    const html = render('1. 一\n2. 二\n');
    expect(html).toContain('<ol');
    expect(html).toContain('一');
    expect(html).toContain('二');
  });
});

describe('MarkdownPreview GFM 扩展', () => {
  it('表格渲染成 table，不再是带管道符的段落', () => {
    const html = render(
      '| 维度 | 网关核心 | 策略平台 |\n| --- | --- | --- |\n| 定位 | 执行者 | 大脑 |\n| 变更频率 | 低 | 高 |\n',
    );
    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th');
    expect(html).toContain('维度');
    expect(html).toContain('执行者');
    expect(html).not.toContain('| --- |');
  });

  it('表格对齐方式落到单元格样式', () => {
    const html = render('| 左 | 右 |\n| :-- | --: |\n| a | b |\n');
    expect(html).toContain('text-align:left');
    expect(html).toContain('text-align:right');
  });

  it('嵌套列表保留层级', () => {
    const html = render('- 父项\n  - 子项\n  - 子项二\n- 父项二\n');
    expect(html.match(/<ul/g)).toHaveLength(2);
    expect(html).toContain('子项');
  });

  it('任务列表输出复选框', () => {
    const html = render('- [x] 已完成\n- [ ] 未完成\n');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });
});

describe('MarkdownPreview 链接与图片策略', () => {
  it('外链新标签打开，站内链接降级为纯文本', () => {
    const html = render('[外](https://example.com) [内](MAIN.md)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('href="MAIN.md"');
  });

  it('独占一行的本地图片用 figure 版式，并带缓存版本号', () => {
    const html = render('![网关](assets/diagrams/gateway.svg)\n', { imageVersion: 7 });
    expect(html).toContain('<figure');
    expect(html).toContain('src="/api/docs/jw/x/assets/diagrams/gateway.svg?v=7"');
  });

  it('行内图片与普通段落共存，不套 figure', () => {
    const html = render('前面 ![小图](assets/a.svg) 后面\n');
    expect(html).not.toContain('<figure');
    expect(html).toContain('align-middle');
    expect(html).toContain('前面');
    expect(html).toContain('后面');
  });

  it('外链图片不发起网络请求', () => {
    const html = render('![远程](https://example.com/x.png)\n');
    expect(html).not.toContain('<img');
    expect(html).toContain('外部图片未加载');
  });

  it('非 assets/ 下的本地路径不渲染成 img', () => {
    const html = render('![越界](../secret.png)\n');
    expect(html).not.toContain('<img');
  });

  it('中文文件名只做一次 URL 编码', () => {
    const html = render('![图](assets/diagrams/智能网关.svg)\n');
    expect(html).toContain('/assets/diagrams/%E6%99%BA%E8%83%BD%E7%BD%91%E5%85%B3.svg');
    expect(html).not.toContain('%25E6');
  });
});
