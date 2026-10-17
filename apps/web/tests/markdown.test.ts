import { describe, expect, it } from 'vitest';
import { parseImageLine, parseInlineImage, parseMarkdown } from '../app/docs/markdown-parse';

describe('parseMarkdown 图片', () => {
  it('独占一行的图片成为 block，且不吞后续段落', () => {
    const blocks = parseMarkdown('# 标题\n\n![网关](assets/diagrams/gateway.svg)\n\n后面的正文。\n');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: '标题' },
      { kind: 'image', alt: '网关', src: 'assets/diagrams/gateway.svg' },
      { kind: 'paragraph', text: '后面的正文。' },
    ]);
  });

  it('支持 title 与单引号 title', () => {
    expect(parseImageLine('![图](assets/a.svg "图题")')).toEqual({ alt: '图', src: 'assets/a.svg', title: '图题' });
    expect(parseImageLine("![图](assets/a.svg '图题')")).toEqual({ alt: '图', src: 'assets/a.svg', title: '图题' });
  });

  it('行内图片与普通段落共存', () => {
    const blocks = parseMarkdown('前面 ![小图](assets/a.svg) 后面\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('paragraph');
    expect(parseInlineImage('![小图](assets/a.svg)')).toEqual({ alt: '小图', src: 'assets/a.svg' });
  });

  it('图片行不会被当成链接/段落；代码块里的图片不解析', () => {
    const blocks = parseMarkdown('```sh\n![x](assets/a.svg)\n```\n![y](assets/b.svg)\n');
    expect(blocks[0]).toMatchObject({ kind: 'code' });
    expect(blocks[1]).toMatchObject({ kind: 'image', alt: 'y' });
  });

  it('普通 Markdown 不受影响', () => {
    const blocks = parseMarkdown('- 一\n- 二\n\n> 引用\n\n---\n');
    expect(blocks.map((block) => block.kind)).toEqual(['ul', 'quote', 'hr']);
  });
});
