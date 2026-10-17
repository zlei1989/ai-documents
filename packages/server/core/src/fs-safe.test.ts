import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathEscapeError, assertInside } from './fs-safe';

describe('fs-safe', () => {
  it('根内已存在的目标不被误判为越界（macOS /var → /private/var）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aidocs-fs-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'MAIN.md'), '# 正文\n');
    expect(() => assertInside(root, join(root, 'docs', 'MAIN.md'))).not.toThrow();
    expect(() => assertInside(root, join(root, 'docs'))).not.toThrow();
    // 目标尚不存在也放行
    expect(() => assertInside(root, join(root, 'docs', '新建.md'))).not.toThrow();
    expect(() => assertInside(root, join(root, '..', 'escape.md'))).toThrowError(PathEscapeError);
  });
});
