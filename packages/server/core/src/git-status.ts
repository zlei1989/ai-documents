import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitHead, GitStatus } from '@aidocs/contracts';
import { git, initRepo, isRepo } from './git-exec';

export const EMPTY_GIT_STATUS: GitStatus = { isRepo: false, branch: null, lastCommit: null, dirty: false };

const GITIGNORE = ['# 我的文档', '.DS_Store', 'node_modules/', '.aidocs/', '*.tmp-*', ''].join('\n');

/** 只读查询：是否仓库 / 分支 / 最近提交 / 未提交变更；非仓库返回全空，不抛错 */
export function gitStatus(dir: string): GitStatus {
  if (!dir || !existsSync(dir)) return { ...EMPTY_GIT_STATUS };
  let repo = false;
  try {
    repo = isRepo(dir);
  } catch {
    repo = false;
  }
  if (!repo) return { ...EMPTY_GIT_STATUS };
  return {
    isRepo: true,
    branch: readBranch(dir),
    lastCommit: readLastCommit(dir),
    dirty: readDirty(dir),
  };
}

function readBranch(dir: string): string | null {
  try {
    const out = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
    return out || null;
  } catch {
    return null; // detached HEAD
  }
}

function readLastCommit(dir: string): GitHead | null {
  try {
    const line = git(dir, ['log', '-1', '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s']).stdout.trim();
    if (!line) return null;
    const [sha, shortSha, at, author, summary = ''] = line.split('\x1f');
    if (!sha || !shortSha || !at) return null;
    return { sha, shortSha, at, author: author ?? '', summary };
  } catch {
    return null; // 空仓库还没有第一个提交
  }
}

function readDirty(dir: string): boolean {
  try {
    return git(dir, ['status', '--porcelain']).stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 显式初始化版本历史（绝不静默调用）：`git init -b main` + `.gitignore` + 首次提交。
 * 已是仓库时只补齐 `.gitignore`，不再造新提交。
 */
export function ensureRepoWithFirstCommit(dir: string): GitStatus {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE, 'utf8');
  if (!isRepo(dir)) initRepo(dir);
  if (!hasHead(dir)) {
    git(dir, ['add', '-A', '--', '.']);
    git(dir, [
      '-c', 'user.name=我的文档',
      '-c', 'user.email=我的文档@localhost',
      'commit', '--no-gpg-sign', '-m', '初始化版本历史', '--', '.',
    ]);
  }
  return gitStatus(dir);
}

function hasHead(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}
