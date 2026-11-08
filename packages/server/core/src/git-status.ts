import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitHead, GitRemote, GitStatus } from '@aidocs/contracts';
import { git, gitOperationInProgress, initRepo, isRepo, unmergedPaths } from './git-exec';

export const EMPTY_GIT_STATUS: GitStatus = {
  isRepo: false,
  branch: null,
  lastCommit: null,
  dirty: false,
  conflicted: [],
  merging: false,
  remote: { name: null, url: null, upstream: null, ahead: 0, behind: 0 },
};

// sessions/<id>.ui.jsonl 是渲染回放日志（派生数据、可能很大），不进版本库；旧版共享 ui.jsonl 一并排除
const GITIGNORE = [
  '# 我的文档',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'node_modules/',
  '.aidocs/',
  '**/sessions/ui.jsonl',
  '**/sessions/*.ui.jsonl',
  '*.tmp-*',
  '',
].join('\n');

/**
 * 只读查询：是否仓库 / 分支 / 最近提交 / 未提交变更 / 远端同步状态 / 冲突。
 * 非仓库返回全空，不抛错；远端只读本地 tracking ref，不发网络请求。
 */
export function gitStatus(dir: string): GitStatus {
  if (!dir || !existsSync(dir)) return { ...EMPTY_GIT_STATUS, remote: { ...EMPTY_GIT_STATUS.remote } };
  let repo = false;
  try {
    repo = isRepo(dir);
  } catch {
    repo = false;
  }
  if (!repo) return { ...EMPTY_GIT_STATUS, remote: { ...EMPTY_GIT_STATUS.remote } };
  const branch = readBranch(dir);
  return {
    isRepo: true,
    branch,
    lastCommit: readLastCommit(dir),
    dirty: readDirty(dir),
    conflicted: unmergedPaths(dir),
    merging: gitOperationInProgress(dir),
    remote: readRemote(dir, branch),
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

/** 远端名 / 地址 / tracking ref / 领先落后；只看本地已知的 refs/remotes，不 fetch */
function readRemote(dir: string, branch: string | null): GitRemote {
  const remotes = readRemotes(dir);
  if (remotes.length === 0) return { name: null, url: null, upstream: null, ahead: 0, behind: 0 };

  const configured = branch ? readConfigValue(dir, `branch.${branch}.remote`) : null;
  // "." 表示跟踪本地分支，不属于远端同步
  const name = (configured && configured !== '.' ? configured : null) ?? remotes[0]!;
  const url = readConfigValue(dir, `remote.${name}.url`);
  const base: GitRemote = { name, url: url ? maskRemoteUrl(url) : null, upstream: null, ahead: 0, behind: 0 };
  if (!branch) return base;

  const upstream = resolveUpstream(dir, branch, name);
  if (!upstream) return base;

  const counts = readAheadBehind(dir, upstream);
  return { ...base, upstream, ...counts };
}

function readRemotes(dir: string): string[] {
  try {
    return git(dir, ['remote']).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readConfigValue(dir: string, key: string): string | null {
  try {
    const value = git(dir, ['config', '--get', key]).stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 先认分支配置的 upstream，再退回仓库里已存在的 <remote>/<branch> */
function resolveUpstream(dir: string, branch: string, remote: string): string | null {
  try {
    const configured = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).stdout.trim();
    if (configured && configured !== '@{u}' && refExists(dir, configured)) return configured;
  } catch {
    /* 没有 upstream 或远端引用已被删除 */
  }
  const fallback = `${remote}/${branch}`;
  return refExists(dir, fallback) ? fallback : null;
}

function refExists(dir: string, ref: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** rev-list --left-right --count <upstream>...HEAD → 左=落后, 右=领先 */
function readAheadBehind(dir: string, upstream: string): { ahead: number; behind: number } {
  try {
    const [behindRaw = '0', aheadRaw = '0'] = git(dir, [
      'rev-list',
      '--left-right',
      '--count',
      `${upstream}...HEAD`,
    ]).stdout.trim().split(/\s+/);
    return { ahead: Number.parseInt(aheadRaw, 10) || 0, behind: Number.parseInt(behindRaw, 10) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/** 远端地址可能带账号 / token：只展示主机与路径 */
export function maskRemoteUrl(url: string): string {
  if (!/^https?:/i.test(url)) return url;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1***@');
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
