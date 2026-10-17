import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, initRepo, isRepo } from './git-exec';

describe('git-exec', () => {
  it('初始化仓库并提交中文文件名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidocs-git-'));
    expect(isRepo(dir)).toBe(false);
    initRepo(dir);
    expect(isRepo(dir)).toBe(true);
    writeFileSync(join(dir, '文档.md'), '# 你好\n');
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
    const out = git(dir, ['log', '--oneline']).stdout;
    expect(out).toContain('init');
    const files = git(dir, ['show', '--name-only', '--format=', 'HEAD']).stdout;
    expect(files).toContain('文档.md');
  });
});
