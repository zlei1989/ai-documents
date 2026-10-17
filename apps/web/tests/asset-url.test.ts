import { describe, expect, it } from 'vitest';
import {
  archifyPosterViewUrl,
  archifySourcePath,
  assetUrl,
  diagramMarkdownRef,
  docBase,
  docFileContentUrl,
  docFileRawUrl,
  docFilesUrl,
  encodePath,
  normalizeAssetPath,
  safeMarkdownAlt,
} from '../app/_lib/asset-url';

describe('asset-url', () => {
  it('逐段编码中文与空格', () => {
    expect(encodePath('assets/diagrams/网关 架构.svg')).toBe('assets/diagrams/%E7%BD%91%E5%85%B3%20%E6%9E%B6%E6%9E%84.svg');
    expect(docBase('jw', '网关架构')).toBe(`/api/docs/jw/${encodeURIComponent('网关架构')}`);
  });

  it('只接受 assets/ 下的本地相对路径', () => {
    expect(normalizeAssetPath('assets/diagrams/a.svg')).toBe('assets/diagrams/a.svg');
    expect(normalizeAssetPath('./assets/diagrams/a.svg')).toBe('assets/diagrams/a.svg');
    expect(normalizeAssetPath('assets/ diagrams/a.svg')).toBe(null);
    for (const bad of [
      'https://example.com/a.png',
      'data:image/svg+xml,<svg/>',
      '/assets/a.svg',
      'research/a.svg',
      'assets/../a.svg',
      'assets/a.svg?x=1',
      'assets/a.svg#x',
      'assets/.hidden/a.svg',
      'assets/a\\b.svg',
      '',
    ]) {
      expect(normalizeAssetPath(bad), bad).toBe(null);
    }
  });

  it('图片 URL 带版本查询破缓存', () => {
    expect(assetUrl('/api/docs/jw/x', 'assets/diagrams/a.svg')).toBe('/api/docs/jw/x/assets/diagrams/a.svg');
    expect(assetUrl('/api/docs/jw/x', 'assets/diagrams/a.svg', 2)).toBe('/api/docs/jw/x/assets/diagrams/a.svg?v=2');
  });

  it('文档文件夹 URL：树 / 内容 / 原始文件（中文与空格编码）', () => {
    const base = '/api/docs/jw/x';
    expect(docFilesUrl(base)).toBe('/api/docs/jw/x/files');
    expect(docFilesUrl('/api/docs/jw/x/')).toBe('/api/docs/jw/x/files');
    expect(docFileContentUrl(base, 'research/笔记 1.md')).toBe(
      '/api/docs/jw/x/files/content?path=research%2F%E7%AC%94%E8%AE%B0%201.md',
    );
    expect(docFileRawUrl(base, 'assets/images/a b.png')).toBe(
      '/api/docs/jw/x/files/raw?path=assets%2Fimages%2Fa%20b.png',
    );
    expect(docFileRawUrl(base, 'assets/images/a.png', '2026-10-17T10:00:00.000Z')).toBe(
      '/api/docs/jw/x/files/raw?path=assets%2Fimages%2Fa.png&v=2026-10-17T10%3A00%3A00.000Z',
    );
  });

  it('Markdown 引用转义方括号', () => {
    expect(safeMarkdownAlt('[草稿] 图')).toBe('［草稿］ 图');
    expect(diagramMarkdownRef('', 'assets/a.svg')).toBe('![图示](assets/a.svg)');
  });

  it('Archify 海报 → 交互 viewer（新标签，未 embed）', () => {
    expect(archifySourcePath('assets/diagrams/a.archify.svg')).toBe('assets/diagrams/a.archify.json');
    expect(archifySourcePath('assets/diagrams/A.ARCHIFY.SVG')).toBe('assets/diagrams/A.archify.json');
    // 普通图片没有交互版，路径原样返回
    expect(archifySourcePath('assets/diagrams/a.svg')).toBe('assets/diagrams/a.svg');
    expect(archifyPosterViewUrl('/api/docs/jw/x', 'assets/diagrams/a.archify.svg')).toBe(
      '/api/docs/jw/x/archify-view/assets/diagrams/a.archify.json?theme=light',
    );
    expect(archifyPosterViewUrl('/api/docs/jw/x', 'assets/diagrams/网关 架构.archify.svg', '7')).toBe(
      '/api/docs/jw/x/archify-view/assets/diagrams/%E7%BD%91%E5%85%B3%20%E6%9E%B6%E6%9E%84.archify.json?v=7&theme=light',
    );
  });
});
