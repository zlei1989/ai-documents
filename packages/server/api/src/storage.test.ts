import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { assertInsideRoot, commitPathAsync, initStorage, resolveStorageRoot, storageStatus } from './storage';
import { expandHomePath, git, initRepo, removeDirSync, resolveStoragePath, validateStorageRoot } from '@aidocs/core';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettings } from './settings';
import { getStorageState, initStorageGit, setStorageRoot } from './storage';
import { ServiceError } from './service-error';
import { isolateConfigDir } from './test-utils';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let env: ReturnType<typeof isolateConfigDir>;
let tmpRoot: string;
const cleanupDirs: string[] = [];

beforeEach(() => {
  env = isolateConfigDir();
  tmpRoot = mkdtempSync(join(tmpdir(), 'aidocs-storage-'));
  cleanupDirs.push(tmpRoot);
});
afterEach(() => {
  env.restore();
  for (const dir of cleanupDirs.splice(0)) removeDirSync(dir);
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  throw new Error('期望抛出 ServiceError，但没有抛错');
}

describe('存储目录', () => {
  it('未选择存储目录时返回空路径与未初始化 git', () => {
    const state = getStorageState();
    expect(state.storageRoot).toBe('');
    expect(state.git).toEqual({
      isRepo: false,
      branch: null,
      lastCommit: null,
      dirty: false,
      conflicted: [],
      merging: false,
      remote: { name: null, url: null, upstream: null, ahead: 0, behind: 0 },
    });
  });

  it('拒绝相对路径与磁盘根目录', () => {
    expect(() => setStorageRoot('relative/dir')).toThrowError(/绝对路径/);
    expect(codeOf(() => setStorageRoot('relative/dir'))).toBe('VALIDATION');
    const volumeRoot = parse(process.cwd()).root;
    expect(() => setStorageRoot(volumeRoot)).toThrowError(/磁盘根目录/);
  });

  it('不限制存放位置：任意盘符/目录都可以（只要可写）', () => {
    const dir = join(tmpRoot, '任意位置', '我的文档');
    const state = setStorageRoot(dir);
    expect(state.storageRoot).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    // 直接校验也接受另一个新目录
    const other = join(tmpRoot, 'another', 'place');
    expect(validateStorageRoot(other)).toBe(other);
  });

  it('支持 ~ 与 ~/xxx 展开到用户主目录', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/文档')).toBe(join(homedir(), '文档'));
    expect(expandHomePath('/absolute/path')).toBe('/absolute/path');
  });

  it('按平台识别绝对路径：不设白名单，Windows 盘符 / UNC 与 POSIX 任意目录都行', () => {
    if (process.platform === 'win32') {
      expect(resolveStoragePath('d:\\.tmp\\a')).toBe('d:\\.tmp\\a');
      expect(resolveStoragePath('D:/data/我的文档')).toBe('D:\\data\\我的文档');
      expect(resolveStoragePath('\\\\server\\share\\docs')).toBe('\\\\server\\share\\docs');
      expect(() => resolveStoragePath('D:')).toThrowError(/绝对路径/);
      expect(() => resolveStoragePath('D:\\')).toThrowError(/磁盘根目录/);
    } else {
      expect(resolveStoragePath('/opt/aidocs')).toBe('/opt/aidocs');
      expect(resolveStoragePath('/mnt/data/我的文档')).toBe('/mnt/data/我的文档');
      expect(resolveStoragePath('/Volumes/外置盘/docs')).toBe('/Volumes/外置盘/docs');
      expect(() => resolveStoragePath('/')).toThrowError(/磁盘根目录/);
      expect(() => resolveStoragePath('C:\\docs')).toThrowError(/绝对路径/);
    }
  });

  it('接受临时目录下的新目录（自动创建）并落盘', () => {
    const dir = join(tmpRoot, '我的文档');
    const state = setStorageRoot(dir);

    expect(state.storageRoot).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(getSettings().storageRoot).toBe(dir);
    expect(getStorageState().storageRoot).toBe(dir);
  });

  it('拒绝文件路径', () => {
    const file = join(tmpRoot, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    expect(() => setStorageRoot(file)).toThrowError(/不是目录/);
  });

  // Windows 的 chmod 不产生只读目录语义，这条只在 POSIX 上有意义
  it.skipIf(process.platform === 'win32')('拒绝不可写目录', () => {
    if (process.getuid?.() === 0) return;
    const readOnly = join(tmpRoot, 'readonly');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    try {
      expect(() => setStorageRoot(join(readOnly, 'sub'))).toThrowError(/不可写/);
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });

  it('初始化版本历史：git init + 首次提交 + .gitignore，重复调用幂等', () => {
    const dir = join(tmpRoot, 'docs');
    setStorageRoot(dir);
    expect(getStorageState().git.isRepo).toBe(false);

    const state = initStorageGit();

    expect(state.git.isRepo).toBe(true);
    expect(state.git.branch).toBe('main');
    expect(state.git.lastCommit?.summary).toBe('初始化版本历史');
    expect(state.git.lastCommit?.shortSha).toHaveLength(7);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(ignore).toContain('.DS_Store');
    expect(ignore).toContain('node_modules');

    // 幂等：已初始化时不再产生新提交
    const sha = state.git.lastCommit?.sha;
    expect(initStorageGit().git.lastCommit?.sha).toBe(sha);
  });

  it('git 状态能反映未提交变更', () => {
    const dir = join(tmpRoot, 'dirty');
    setStorageRoot(dir);
    initStorageGit();
    writeFileSync(join(dir, '新文档.md'), '# 你好\n');
    expect(getStorageState().git.dirty).toBe(true);
  });

  it('未选择存储目录时初始化给出中文错误', () => {
    expect(() => initStorageGit()).toThrowError(/请先选择存储目录/);
    expect(codeOf(() => initStorageGit())).toBe('VALIDATION');
  });
});

/* ---------- impl-03（M3）存储测试 ---------- */
describe('storage', () => {
  it('未初始化时报告非仓库，初始化后产生首个提交', () => {
    const root = tempDir('aidocs-storage-');

    const before = storageStatus(root);
    expect(before.configured).toBe(true);
    expect(before.exists).toBe(true);
    expect(before.isRepo).toBe(false);
    expect(before.commitCount).toBe(0);
    expect(before.recentCommits).toEqual([]);

    const after = initStorage(root);
    expect(after.isRepo).toBe(true);
    expect(after.commitCount).toBe(1);
    expect(after.recentCommits).toHaveLength(1);
    expect(after.recentCommits[0]?.summary).toContain('初始化');
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
  });

  it('从 config 解析 storageRoot', () => {
    const configDir = tempDir('aidocs-config-');
    const root = tempDir('aidocs-root-');
    const previous = process.env.AIDOCS_CONFIG_DIR;
    process.env.AIDOCS_CONFIG_DIR = configDir;
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ settings: { storageRoot: root } }));
      expect(resolveStorageRoot()).toBe(root);
      expect(storageStatus().root).toBe(root);
      expect(storageStatus().configured).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AIDOCS_CONFIG_DIR;
      else process.env.AIDOCS_CONFIG_DIR = previous;
    }
  });

  it('未配置 storageRoot 时解析报 VALIDATION', () => {
    const configDir = tempDir('aidocs-config-');
    const previous = process.env.AIDOCS_CONFIG_DIR;
    process.env.AIDOCS_CONFIG_DIR = configDir;
    try {
      expect(() => resolveStorageRoot()).toThrowError(ServiceError);
      expect(() => resolveStorageRoot()).toThrowError(/存储根/);
      expect(storageStatus().configured).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AIDOCS_CONFIG_DIR;
      else process.env.AIDOCS_CONFIG_DIR = previous;
    }
  });

  it('自动提交不会把 sessions/*.ui.jsonl 带进版本库（1.2MB 也不进）', async () => {
    const root = tempDir('aidocs-autocommit-');
    cleanupDirs.push(root);
    initRepo(root);
    const artifact = join(root, 'docs', 'g', 'n');
    mkdirSync(join(artifact, 'sessions'), { recursive: true });
    writeFileSync(join(artifact, 'MAIN.md'), '# 正文\n', 'utf8');
    writeFileSync(join(artifact, 'sessions', 'ui.jsonl'), 'x'.repeat(1_200_000), 'utf8');
    writeFileSync(join(artifact, 'sessions', 's-1.ui.jsonl'), 'y'.repeat(1_200_000), 'utf8');

    const sha = await commitPathAsync(root, 'docs/g/n', 'ai: g/n · 本轮修改');
    expect(sha).toBeTruthy();

    const tracked = git(root, ['ls-files']).stdout;
    expect(tracked).toContain('docs/g/n/MAIN.md');
    expect(tracked).not.toContain('sessions/ui.jsonl');
    expect(tracked).not.toContain('sessions/s-1.ui.jsonl');
    // 渲染日志留在工作区，只是不提交
    expect(existsSync(join(artifact, 'sessions', 'ui.jsonl'))).toBe(true);
    expect(existsSync(join(artifact, 'sessions', 's-1.ui.jsonl'))).toBe(true);
  });

  it('路径穿越被拒绝', () => {
    const root = tempDir('aidocs-root-');
    expect(() => assertInsideRoot(root, join(root, '..', 'escape.txt'))).toThrowError(ServiceError);
    expect(() => assertInsideRoot(root, join(root, '..', 'escape.txt'))).toThrowError(/越界/);
    // 根内的正常路径放行
    expect(assertInsideRoot(root, join(root, 'docs'))).toBe(join(root, 'docs'));
  });
});
