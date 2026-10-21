import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '@aidocs/ui';

function render(props: Partial<ComponentProps<typeof ChatPanel>> = {}): string {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      group: '分组',
      name: '文档',
      ...props,
    }),
  );
}

describe('ChatPanel 文档文件夹入口', () => {
  it('filesOpen 时用注入面板替换消息流与输入框', () => {
    const html = render({
      filesOpen: true,
      onToggleFiles: () => {},
      filesPanel: createElement('div', null, 'FILE-PANEL'),
    });
    expect(html).toContain('文档文件夹');
    expect(html).toContain('返回创作会话');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('FILE-PANEL');
    expect(html).not.toContain('还没有对话');
    expect(html).not.toContain('继续说');
  });

  it('默认显示创作会话与文件入口，不渲染面板', () => {
    const html = render({
      onToggleFiles: () => {},
      filesPanel: createElement('div', null, 'FILE-PANEL'),
    });
    expect(html).toContain('创作会话');
    expect(html).toContain('查看文档文件');
    expect(html).toContain('会话列表');
    expect(html).toContain('还没有对话');
    expect(html).not.toContain('FILE-PANEL');
  });

  it('收起竖条在文件视图下提示文档文件', () => {
    const html = render({ collapsed: true, filesOpen: true, onToggleFiles: () => {} });
    expect(html).toContain('文档文件');
    expect(html).not.toContain('FILE-PANEL');
  });
});
