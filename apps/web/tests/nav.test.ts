import { describe, expect, it } from 'vitest';
import { docToWorkspaceHref, typeEditorHref } from '../app/_lib/doc-nav';

describe('类型编辑器往返地址', () => {
  it('doc → 创作页，逐段编码中文', () => {
    expect(docToWorkspaceHref('jw/网关架构')).toBe(
      `/workspace/${encodeURIComponent('jw')}/${encodeURIComponent('网关架构')}`,
    );
  });

  it('缺 doc / 段数不对 / 空段时返回 null', () => {
    expect(docToWorkspaceHref(undefined)).toBeNull();
    expect(docToWorkspaceHref('')).toBeNull();
    expect(docToWorkspaceHref('jw')).toBeNull();
    expect(docToWorkspaceHref('jw/网关架构/extra')).toBeNull();
    expect(docToWorkspaceHref('/网关架构')).toBeNull();
    expect(docToWorkspaceHref('jw/')).toBeNull();
  });

  it('类型地址带 doc 时把整串 doc 编码进查询参数', () => {
    const href = typeEditorHref('科普文章', 'jw/网关架构');
    expect(href).toBe(`/types/${encodeURIComponent('科普文章')}?doc=${encodeURIComponent('jw/网关架构')}`);
    expect(new URL(href, 'http://localhost').searchParams.get('doc')).toBe('jw/网关架构');
  });

  it('无 doc 时不带查询参数', () => {
    expect(typeEditorHref('科普文章')).toBe(`/types/${encodeURIComponent('科普文章')}`);
    expect(typeEditorHref('科普文章', 'bad-doc')).toBe(`/types/${encodeURIComponent('科普文章')}`);
  });
});
