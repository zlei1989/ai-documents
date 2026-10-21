import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, initRepo } from '@aidocs/core';
import { abortCurrentMerge, groupChangedPaths, startCurrentRepair, syncStorage } from './git-sync';
import { commitPathAsync, setStorageRoot } from './storage';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;
let base: string;
let remote: string;
let local: string;

function commit(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function cloneOther(name = 'other'): string {
  const dir = join(base, name);
  git(base, ['clone', remote, name]);
  return dir;
}

function editAndPush(dir: string, content: string, message: string): void {
  writeFileSync(join(dir, '文档.md'), content);
  commit(dir, message);
  git(dir, ['push']);
}

beforeEach(() => {
  env = isolateConfigDir();
  base = mkdtempSync(join(tmpdir(), 'aidocs-sync-'));
  remote = join(base, 'remote.git');
  git(base, ['init', '--bare', '-b', 'main', 'remote.git']);
  local = join(base, 'local');
  mkdirSync(local);
  initRepo(local);
  writeFileSync(join(local, '文档.md'), '# 第一版\n');
  commit(local, 'init');
  git(local, ['remote', 'add', 'origin', remote]);
  git(local, ['push', '-u', 'origin', 'main']);
  setStorageRoot(local);
});

afterEach(() => {
  env.restore();
  rmSync(base, { recursive: true, force: true });
});

describe('推送前按文件夹归组', () => {
  it('文档到 artifact、类型/技能到各自目录、根文件单独一组', () => {
    const groups = groupChangedPaths([
      'docs/JW/智能网关/MAIN.md',
      'docs/JW/智能网关/assets/a.png',
      'docs/JW/智能网关/MAIN.md',
      'docs/其它/篇/meta.yaml',
      'types/技术方案/type.yaml',
      'skills/写作/SKILL.md',
      'README.md',
      '.gitignore',
      'research/x/y.md',
    ]);
    const byPath = Object.fromEntries(groups.map((group) => [group.path, group]));

    expect(byPath['docs/JW/智能网关']).toEqual({
      path: 'docs/JW/智能网关',
      label: 'JW/智能网关',
      paths: ['docs/JW/智能网关/MAIN.md', 'docs/JW/智能网关/assets/a.png'],
    });
    expect(byPath['docs/其它/篇']?.label).toBe('其它/篇');
    expect(byPath['types/技术方案']?.label).toBe('类型 技术方案');
    expect(byPath['skills/写作']?.label).toBe('技能 写作');
    expect(byPath.research?.label).toBe('research');
    expect(byPath['.']).toEqual({ path: '.', label: '根目录', paths: ['README.md', '.gitignore'] });
    // 直接落在 docs/types 下的散文件按完整路径成组，不能变成会吞掉整棵目录的 docs/types
    expect(groupChangedPaths(['docs/README.md', 'types/foo.md']).map((group) => group.path)).toEqual([
      'docs/README.md',
      'types/foo.md',
    ]);
  });
});

describe('拉取 / 推送', () => {
  it('拉取快进到远端最新提交', async () => {
    const other = cloneOther();
    editAndPush(other, '# 远端版本\n', 'remote edit');

    const result = await syncStorage('pull');

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ok');
    expect(readFileSync(join(local, '文档.md'), 'utf8')).toBe('# 远端版本\n');
    expect(result.status.remote.behind).toBe(0);
  });

  it('拉取出冲突：返回冲突文件并交给注入的修复器', async () => {
    const other = cloneOther();
    editAndPush(other, '# 远端版本\n', 'remote edit');
    writeFileSync(join(local, '文档.md'), '# 本地版本\n');
    commit(local, 'local edit');

    const result = await syncStorage('pull', {
      startRepair: () => ({ id: 'rp-test', files: ['文档.md'] }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('conflict');
    expect(result.repairId).toBe('rp-test');
    expect(result.files).toEqual(['文档.md']);
    expect(result.status.conflicted).toEqual(['文档.md']);
    expect(result.status.merging).toBe(true);
    expect(readFileSync(join(local, '文档.md'), 'utf8')).toContain('<<<<<<<');

    // 合并冲突期间自动提交必须让路，不能把半成品提交成合并提交
    const headBefore = git(local, ['rev-parse', 'HEAD']).stdout.trim();
    expect(await commitPathAsync(local, 'docs', 'ai: 抢跑')).toBeNull();
    expect(git(local, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);

    const aborted = abortCurrentMerge();
    expect(aborted.conflicted).toEqual([]);
    expect(aborted.merging).toBe(false);
    expect(readFileSync(join(local, '文档.md'), 'utf8')).toBe('# 本地版本\n');
  });

  it('冲突已清空但合并未提交：直接完成合并提交，不启动 pi', async () => {
    const other = cloneOther();
    editAndPush(other, '# 远端版本\n', 'remote edit');
    writeFileSync(join(local, '文档.md'), '# 本地版本\n');
    commit(local, 'local edit');
    await syncStorage('pull', { startRepair: () => ({ id: 'rp-test', files: ['文档.md'] }) });

    // 模拟人工/pi 已改好文件并 stage，但合并提交还没做
    writeFileSync(join(local, '文档.md'), '# 合并完成\n');
    git(local, ['add', '文档.md']);
    expect(git(local, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).stdout.trim()).toBeTruthy();

    const done = startCurrentRepair();
    expect(done.committed).toBe(true);
    expect(done.sha).toBeTruthy();
    expect(git(local, ['rev-list', '--parents', '-1', 'HEAD']).stdout.trim().split(/\s+/)).toHaveLength(3);
    expect(git(local, ['status', '--porcelain']).stdout.trim()).toBe('');
  });

  it('冲突标记没清干净时拒绝完成合并', async () => {
    const other = cloneOther();
    editAndPush(other, '# 远端版本\n', 'remote edit');
    writeFileSync(join(local, '文档.md'), '# 本地版本\n');
    commit(local, 'local edit');
    await syncStorage('pull', { startRepair: () => ({ id: 'rp-test', files: ['文档.md'] }) });

    // 手动把带标记的文件 stage 掉：git 认为已解决，但内容仍是半成品
    writeFileSync(join(local, '文档.md'), '<<<<<<< HEAD\n本地\n=======\n远端\n>>>>>>> origin/main\n');
    git(local, ['add', '文档.md']);

    expect(() => startCurrentRepair()).toThrow(/冲突标记/);
    expect(git(local, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).stdout.trim()).toBeTruthy();
  });

  it('推送前按文件夹生成提交，再推送；远端领先时提示先拉取', async () => {
    // 四个维度：文档 artifact / 类型 / 技能 / 根目录；另加一份不应入库的 UI 日志
    writeFileSync(join(local, 'README.md'), '# 根目录\n');
    mkdirSync(join(local, 'types', 't1'), { recursive: true });
    writeFileSync(join(local, 'types', 't1', 'type.yaml'), 'name: t1\n');
    mkdirSync(join(local, 'skills', '写作'), { recursive: true });
    writeFileSync(join(local, 'skills', '写作', 'SKILL.md'), '# skill\n');
    mkdirSync(join(local, 'docs', 'JW', '智能网关', 'sessions'), { recursive: true });
    writeFileSync(join(local, 'docs', 'JW', '智能网关', 'extra.md'), '# extra\n');
    writeFileSync(join(local, 'docs', 'JW', '智能网关', 'sessions', 'x.ui.jsonl'), '{}\n');

    const pushed = await syncStorage('push');

    expect(pushed.ok).toBe(true);
    expect(pushed.commits.map((commit) => commit.path)).toEqual(['docs/JW/智能网关', 'types/t1', 'skills/写作', '.']);
    expect(pushed.commits.map((commit) => commit.label)).toEqual(['JW/智能网关', '类型 t1', '技能 写作', '根目录']);
    // 只有真正入库的文件计数；sessions/*.ui.jsonl 被排除
    expect(pushed.commits.map((commit) => commit.files)).toEqual([1, 1, 1, 1]);
    expect(git(local, ['log', '-4', '--format=%s']).stdout.trim().split('\n')).toEqual([
      'human: 根目录 · 推送前提交',
      'human: 技能 写作 · 推送前提交',
      'human: 类型 t1 · 推送前提交',
      'human: JW/智能网关 · 推送前提交',
    ]);
    expect(git(remote, ['log', '-1', '--format=%s']).stdout.trim()).toBe('human: 根目录 · 推送前提交');
    // 派生日志不进推送提交
    expect(git(local, ['ls-files', 'docs/JW/智能网关/sessions/x.ui.jsonl']).stdout.trim()).toBe('');

    const other = cloneOther();
    editAndPush(other, '# 远端版本\n', 'remote edit');
    const behind = await syncStorage('push');
    expect(behind.ok).toBe(false);
    expect(behind.reason).toBe('behind');
    expect(behind.message).toContain('先拉取');
    expect(behind.commits).toEqual([]);
  });

  it('没有远端时给出中文 VALIDATION', async () => {
    const noRemote = join(base, 'no-remote');
    mkdirSync(noRemote);
    initRepo(noRemote);
    writeFileSync(join(noRemote, 'a.md'), 'a\n');
    commit(noRemote, 'init');
    setStorageRoot(noRemote);

    await expect(syncStorage('pull')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('storageRoot 指向仓库子目录时拒绝同步', async () => {
    setStorageRoot(join(local, 'docs'));
    await expect(syncStorage('pull')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('tracked 改动阻止拉取；未跟踪文件不阻止', async () => {
    writeFileSync(join(local, '文档.md'), '# 本地未提交\n');
    await expect(syncStorage('pull')).rejects.toMatchObject({ code: 'CONFLICT' });

    commit(local, 'commit local');
    writeFileSync(join(local, '草稿.txt'), 'untracked\n');
    const result = await syncStorage('pull');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已经是最新');
  });
});
