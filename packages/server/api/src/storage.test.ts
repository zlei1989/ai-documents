import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { assertInsideRoot, initStorage, resolveStorageRoot, storageStatus } from './storage';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    expect(state.git).toEqual({ isRepo: false, branch: null, lastCommit: null, dirty: false });
  });

  it('拒绝相对路径、根目录与系统目录', () => {
    expect(() => setStorageRoot('relative/dir')).toThrowError(/绝对路径/);
    expect(codeOf(() => setStorageRoot('relative/dir'))).toBe('VALIDATION');
    expect(() => setStorageRoot('/')).toThrowError(/系统目录|允许/);
    expect(() => setStorageRoot('/System/foo')).toThrowError(/系统目录/);
    expect(() => setStorageRoot('/usr/local/mydocs')).toThrowError(/系统目录/);
  });

  it('接受临时目录下的新目录（自动创建）并落盘', () => {
    const dir = join(tmpRoot, '我的文档');
    const state = setStorageRoot(dir);

    expect(state.storageRoot).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(getSettings().storageRoot).toBe(dir);
    expect(getStorageState().storageRoot).toBe(dir);
  });

  it('拒绝文件路径与不可写目录', () => {
    const file = join(tmpRoot, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    expect(() => setStorageRoot(file)).toThrowError(/不是目录/);

    if (process.getuid?.() !== 0) {
      const readOnly = join(tmpRoot, 'readonly');
      mkdirSync(readOnly);
      chmodSync(readOnly, 0o555);
      try {
        expect(() => setStorageRoot(join(readOnly, 'sub'))).toThrowError(/不可写/);
      } finally {
        chmodSync(readOnly, 0o755);
      }
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

  it('路径穿越被拒绝', () => {
    const root = tempDir('aidocs-root-');
    expect(() => assertInsideRoot(root, join(root, '..', 'escape.txt'))).toThrowError(ServiceError);
    expect(() => assertInsideRoot(root, join(root, '..', 'escape.txt'))).toThrowError(/越界/);
    // 根内的正常路径放行
    expect(assertInsideRoot(root, join(root, 'docs'))).toBe(join(root, 'docs'));
  });
});
