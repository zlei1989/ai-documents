import { describe, expect, it } from 'vitest';
import {
  ASSETS_ROOT,
  DIAGRAMS_DIR,
  assetContentType,
  assetRelativeOrNull,
  diagramMarkdownRef,
  diagramSlug,
  normalizeAssetPath,
  normalizeAssetRelativePath,
  safeMarkdownAlt,
} from './diagram';

describe('diagram path helpers', () => {
  it('接受 assets/ 下的相对路径，拒绝穿越/绝对/隐藏/反斜杠', () => {
    expect(normalizeAssetRelativePath('diagrams/a.svg')).toBe('diagrams/a.svg');
    expect(normalizeAssetRelativePath('flows/网关.svg')).toBe('flows/网关.svg');
    for (const bad of ['', '../a.svg', '/a.svg', 'a/../b.svg', '.hidden/a.svg', 'a\\b.svg', 'a//b.svg']) {
      expect(() => normalizeAssetRelativePath(bad), bad).toThrow();
    }
  });

  it('完整资源路径必须以 assets/ 开头', () => {
    expect(normalizeAssetPath('assets/diagrams/a.svg')).toBe('assets/diagrams/a.svg');
    expect(() => normalizeAssetPath('diagrams/a.svg')).toThrow(/assets\//);
    expect(() => normalizeAssetPath('/assets/a.svg')).toThrow();
    expect(assetRelativeOrNull('assets/diagrams/a.svg')).toBe('diagrams/a.svg');
    expect(assetRelativeOrNull('research/a.svg')).toBeNull();
    expect(assetRelativeOrNull('assets/../x.svg')).toBeNull();
  });

  it('SVG 判定与 MIME', () => {
    expect(assetContentType('a.svg')).toMatchObject({ type: 'image/svg+xml; charset=utf-8', inline: true });
    expect(assetContentType('a.PNG')).toMatchObject({ type: 'image/png', inline: true });
    expect(assetContentType('a.html')).toEqual({ type: 'application/octet-stream', inline: false });
  });

  it('slug 保留中文、过滤 Markdown 歧义字符', () => {
    expect(diagramSlug('网关架构')).toBe('网关架构');
    expect(diagramSlug('A/B (C)')).toBe('A-B-C');
    expect(diagramSlug(' 多个   空格 ')).toBe('多个-空格');
    expect(diagramSlug('...')).toBe('图示');
    expect(diagramSlug('')).toBe('图示');
    expect(diagramSlug('a'.repeat(100)).length).toBe(60);
  });

  it('Markdown 引用转义方括号/换行', () => {
    expect(safeMarkdownAlt(' 标题\n[草稿] ')).toBe('标题 ［草稿］');
    expect(diagramMarkdownRef('网关', 'assets/diagrams/a.svg')).toBe('![网关](assets/diagrams/a.svg)');
    expect(diagramMarkdownRef('', 'assets/diagrams/a.svg')).toBe('![图示](assets/diagrams/a.svg)');
    expect(ASSETS_ROOT).toBe('assets');
  });
});
