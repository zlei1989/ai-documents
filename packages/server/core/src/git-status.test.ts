import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, initRepo } from './git-exec';
import { gitStatus, maskRemoteUrl } from './git-status';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function commit(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function initLocal(dir: string): void {
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
  writeFileSync(join(dir, '文档.md'), '# 第一版\n');
  commit(dir, 'init');
}

function bareRemote(base: string): string {
  const remote = join(base, 'remote.git');
  git(base, ['init', '--bare', '-b', 'main', 'remote.git']);
  return remote;
}

describe('gitStatus：远端与冲突', () => {
  it('读取远端名 / 地址 / upstream 与 ahead-behind', () => {
    const base = tempDir('aidocs-status-');
    const remote = bareRemote(base);
    const local = join(base, 'local');
    initLocal(local);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-u', 'origin', 'main']);

    const clean = gitStatus(local);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.remote).toEqual({ name: 'origin', url: remote, upstream: 'origin/main', ahead: 0, behind: 0 });

    const other = join(base, 'other');
    git(base, ['clone', remote, 'other']);
    writeFileSync(join(other, '文档.md'), '# 远端改过\n');
    commit(other, 'remote change');
    git(other, ['push']);

    git(local, ['fetch', 'origin']);
    const behind = gitStatus(local);
    expect(behind.remote.behind).toBe(1);
    expect(behind.remote.ahead).toBe(0);

    writeFileSync(join(local, 'local.md'), '# 本地\n');
    commit(local, 'local change');
    expect(gitStatus(local).remote.ahead).toBe(1);
  });

  it('冲突时报告 conflicted 与 merging，解决后清空', () => {
    const base = tempDir('aidocs-status-conflict-');
    const remote = bareRemote(base);
    const local = join(base, 'local');
    initLocal(local);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-u', 'origin', 'main']);

    const other = join(base, 'other');
    git(base, ['clone', remote, 'other']);
    writeFileSync(join(other, '文档.md'), '# 远端版本\n');
    commit(other, 'remote edit');
    git(other, ['push']);

    writeFileSync(join(local, '文档.md'), '# 本地版本\n');
    commit(local, 'local edit');
    git(local, ['fetch', 'origin']);
    expect(() => git(local, ['merge', 'origin/main'])).toThrow();

    const conflicted = gitStatus(local);
    expect(conflicted.conflicted).toEqual(['文档.md']);
    expect(conflicted.merging).toBe(true);
    expect(conflicted.dirty).toBe(true);

    writeFileSync(join(local, '文档.md'), '# 合并后的版本\n');
    git(local, ['add', '文档.md']);
    git(local, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--no-edit']);

    const resolved = gitStatus(local);
    expect(resolved.conflicted).toEqual([]);
    expect(resolved.merging).toBe(false);
    expect(resolved.remote.upstream).toBe('origin/main');
  });

  it('远端地址脱敏，SSH 地址原样保留', () => {
    expect(maskRemoteUrl('https://user:token@example.com/a.git')).toBe('https://***@example.com/a.git');
    expect(maskRemoteUrl('http://token@example.com/a.git')).toBe('http://***@example.com/a.git');
    expect(maskRemoteUrl('git@example.com:a.git')).toBe('git@example.com:a.git');
  });

  it('没有远端 / 非仓库时返回空 remote，不抛错', () => {
    const bare = tempDir('aidocs-status-empty-');
    initLocal(bare);
    expect(gitStatus(bare).remote).toEqual({ name: null, url: null, upstream: null, ahead: 0, behind: 0 });

    const plain = tempDir('aidocs-status-plain-');
    expect(gitStatus(plain).isRepo).toBe(false);
    expect(gitStatus(plain).conflicted).toEqual([]);
  });
});
