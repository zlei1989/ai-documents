import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDoc } from './docs';
import { readAsset, resolveAssetFile, resolveArtifact } from './diagrams';
import { ServiceError } from './service-error';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400"><title>架构</title><rect x="10" y="10" width="100" height="40" fill="#eef2ff" stroke="#4f46e5"/></svg>';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aidocs-assets-api-'));
  createDoc(root, { group: '分组', name: '文档', type: '类型' });
  mkdirSync(join(root, 'docs', '分组', '文档', 'assets', 'diagrams'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function assetPath(rel = 'diagrams/a.svg'): string {
  return join(root, 'docs', '分组', '文档', 'assets', rel);
}

function writeAsset(content: string, rel = 'diagrams/a.svg'): void {
  const file = assetPath(rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

/** Windows 默认策略不允许创建符号链接（需要开发者模式/管理员）；建不了就跳过相关断言 */
function symlinkIfSupported(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

describe('assets api（只读）', () => {
  it('普通 SVG 只读展示：保留 class/style，移除脚本/外链', () => {
    writeAsset(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>.a{fill:red}</style><rect class="a" width="10" height="10"/><script>alert(1)</script><image href="https://x.test/a.png"/></svg>',
    );
    const asset = readAsset(root, '分组', '文档', 'diagrams/a.svg');
    const content = asset.bytes.toString('utf8');
    expect(asset.contentType).toContain('image/svg+xml');
    expect(asset.inline).toBe(true);
    expect(content).toContain('<style>');
    expect(content).toContain('class="a"');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('https://x.test');
    expect(asset.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('Archify 海报同样走 poster 净化', () => {
    writeAsset(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.c{fill:#123456}</style><rect class="c" width="10" height="10"/></svg>',
      'diagrams/a.archify.svg',
    );
    const asset = readAsset(root, '分组', '文档', 'diagrams/a.archify.svg');
    expect(asset.contentType).toContain('image/svg+xml');
    expect(asset.bytes.toString('utf8')).toContain('class="c"');
  });

  it('非图片给附件；路径穿越/符号链接被拒绝', () => {
    writeAsset('<html>hi</html>', 'notes.html');
    const text = readAsset(root, '分组', '文档', 'notes.html');
    expect(text.inline).toBe(false);

    expect(() => readAsset(root, '分组', '文档', '../secret.svg')).toThrow(ServiceError);

    writeAsset(SVG);
    const link = assetPath('diagrams/link.svg');
    if (symlinkIfSupported(assetPath('diagrams/a.svg'), link)) {
      expect(() => resolveAssetFile(resolveArtifact(root, '分组', '文档'), 'diagrams/link.svg')).toThrow(ServiceError);
    }
  });

  it('缺失/超大资源被拒绝', () => {
    expect(() => readAsset(root, '分组', '文档', 'diagrams/missing.svg')).toThrow(/不存在/);
    writeAsset(SVG, 'diagrams/a.svg');
    const asset = readAsset(root, '分组', '文档', 'diagrams/a.svg');
    expect(asset.bytes.toString('utf8')).toContain('<svg');
  });
});
