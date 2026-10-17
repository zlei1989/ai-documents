import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '../app/docs/markdown';

function render(source: string, options: { openArchifyOnClick?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(MarkdownPreview, {
      source,
      assetBase: '/api/docs/jw/x',
      ...options,
    }),
  );
}

describe('MarkdownPreview 里的 Archify 海报', () => {
  const source = '![网关](assets/diagrams/gateway.archify.svg)\n';

  it('只读页开启后，点击海报在新标签打开交互 viewer', () => {
    const html = render(source, { openArchifyOnClick: true });
    expect(html).toContain(
      'href="/api/docs/jw/x/archify-view/assets/diagrams/gateway.archify.json?theme=light"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('创作页不传开关时不包链接（入口在右键菜单）', () => {
    expect(render(source)).not.toContain('archify-view');
  });

  it('普通图片即使开启开关也不可点', () => {
    expect(render('![图](assets/a.svg)', { openArchifyOnClick: true })).not.toContain('<a ');
  });
});
