import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import type { GitStatus, GitSyncAction, GitSyncCommit, GitSyncResult } from '@aidocs/contracts';
import {
  AUTO_COMMIT_EXCLUDES,
  GitError,
  NON_INTERACTIVE_GIT_ENV,
  git,
  gitAsync,
  gitOperationInProgress,
  gitStatus,
  isRepo,
  unmergedPaths,
} from '@aidocs/core';
import { abortMerge, completeMerge, startRepairJob } from './git-repair';
import { ServiceError } from './service-error';
import { resolveStorageRoot } from './storage';

const LOCK_KEY = '__aidocs_git_sync_locks__';
const locks = (globalThis as unknown as Record<string, Set<string> | undefined>)[LOCK_KEY] ??= new Set<string>();

/** 同一 storageRoot 同时只允许一个拉取/推送；修复任务另有一把锁 */
async function withSyncLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  if (locks.has(root)) throw new ServiceError('CONFLICT', '已有拉取/推送在进行中，请稍候');
  locks.add(root);
  try {
    return await run();
  } finally {
    locks.delete(root);
  }
}

function statusOf(root: string): GitStatus {
  return gitStatus(root);
}

/**
 * 应用把 storageRoot 当仓库根用（冲突路径、自动提交 pathspec 都相对它）。
 * 指向某个仓库的子目录时，`git status` 的路径是相对仓库根的，stage 会错位，直接拒绝。
 */
function assertRepoRoot(root: string): void {
  try {
    const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim();
    // realpath 之后用 relative 比较：Windows / macOS 的大小写不敏感文件系统上，
    // git 输出 `D:/repo`、用户填 `d:\repo` 也是同一个目录
    if (top && relative(realpathSync(top), realpathSync(root)) === '') return;
  } catch {
    /* 下面统一报错 */
  }
  throw new ServiceError('VALIDATION', '存储目录不是 git 仓库根目录：请把 storageRoot 指向仓库根，而不是它的子目录');
}

function branchOf(root: string): string {
  try {
    const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
    if (!branch) throw new ServiceError('VALIDATION', '当前是 detached HEAD，请先切回分支');
    return branch;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('VALIDATION', '读取当前分支失败，请确认仓库状态');
  }
}

function remoteNameOf(root: string, branch: string): string {
  try {
    const configured = git(root, ['config', '--get', `branch.${branch}.remote`]).stdout.trim();
    if (configured && configured !== '.') return configured;
  } catch {
    /* 没有配置 */
  }
  try {
    const remotes = git(root, ['remote']).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (remotes.length > 0) return remotes[0]!;
  } catch {
    /* ignore */
  }
  throw new ServiceError('VALIDATION', '还没有配置远端仓库：先执行 git remote add origin <url>');
}

/** 已 fetch 到的远端引用；优先分支配置的 upstream，其次 <remote>/<branch> */
function upstreamOf(root: string, branch: string, remote: string): string | null {
  try {
    const configured = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).stdout.trim();
    if (configured && configured !== '@{u}' && refExists(root, configured)) return configured;
  } catch {
    /* 远端引用可能已被删除 */
  }
  const fallback = `${remote}/${branch}`;
  return refExists(root, fallback) ? fallback : null;
}

function refExists(root: string, ref: string): boolean {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** 只看 tracked 的改动；未跟踪文件不阻止拉取（真撞上了让 git 自己拒绝） */
function trackedDirty(root: string): string[] {
  const out = git(root, ['status', '--porcelain']).stdout;
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function gitErrorText(error: unknown): string {
  if (error instanceof GitError) return error.context.stderr || error.message;
  return String((error as Error)?.message ?? error);
}

function describeGitFailure(error: unknown): { reason: 'behind' | 'error'; message: string } {
  const text = gitErrorText(error);
  if (/non-fast-forward|fetch first|\[rejected\]|Updates were rejected|tip of your current branch is behind/i.test(text)) {
    return { reason: 'behind', message: '远端有新提交，请先拉取再推送' };
  }
  if (/untracked working tree files would be overwritten/i.test(text)) {
    return { reason: 'error', message: '有未跟踪文件会被远端改动覆盖；先移走或提交这些文件再拉取' };
  }
  if (/local changes to the following files would be overwritten/i.test(text)) {
    return { reason: 'error', message: '本地改动会被远端覆盖；先提交后再拉取' };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return { reason: 'error', message: 'SSH 主机密钥未确认：先在终端 ssh 一次确认主机指纹' };
  }
  if (/Permission denied|Authentication failed|could not read Username|terminal prompts disabled|publickey/i.test(text)) {
    return { reason: 'error', message: '远端认证失败：检查 SSH key 或 HTTPS 凭据' };
  }
  if (/Could not resolve host|Connection timed out|Network is unreachable|Operation timed out|Connection refused/i.test(text)) {
    return { reason: 'error', message: '无法连接远端：检查网络、VPN 或仓库地址' };
  }
  if (/repository .* not found|does not appear to be a git repository|No such remote/i.test(text)) {
    return { reason: 'error', message: '远端仓库不可用：检查地址与访问权限' };
  }
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('fatal:') && !line.startsWith('error:'));
  const detail = (first ?? text.split('\n')[0] ?? 'git 失败').slice(0, 180);
  return { reason: 'error', message: detail };
}

/** 测试注入点：默认真实启动 pi 修复任务 */
export type StartRepair = (root: string) => { id: string; files: string[] };

function conflictResult(
  root: string,
  action: GitSyncAction,
  files: string[],
  startRepair: StartRepair,
): GitSyncResult {
  let repairId: string | null = null;
  let repairError = '';
  try {
    repairId = startRepair(root).id;
  } catch (error) {
    repairError = (error as Error)?.message ?? String(error);
  }
  const status = statusOf(root);
  if (repairId) {
    return {
      ok: false,
      action,
      reason: 'conflict',
      message: `拉取产生 ${files.length} 个冲突，pi 已开始修复`,
      files,
      repairId,
      commits: [],
      status,
    };
  }
  return {
    ok: false,
    action,
    reason: 'conflict',
    message: `拉取产生 ${files.length} 个冲突；无法启动 pi 修复：${repairError || '没有可用模型'}`,
    files,
    repairId: null,
    commits: [],
    status,
  };
}

async function pull(root: string, branch: string, startRepair: StartRepair): Promise<GitSyncResult> {
  if (unmergedPaths(root).length > 0 || gitOperationInProgress(root)) {
    throw new ServiceError('CONFLICT', '已有未完成的合并或冲突，请先修复或放弃本次合并');
  }
  const dirty = trackedDirty(root);
  if (dirty.length > 0) {
    throw new ServiceError('CONFLICT', `工作区有 ${dirty.length} 个未提交改动，等自动提交完成或先提交后再拉取`, {
      files: dirty.slice(0, 10),
    });
  }

  const remote = remoteNameOf(root, branch);
  try {
    await gitAsync(root, ['fetch', '--prune', remote], {
      timeoutMs: 120_000,
      env: NON_INTERACTIVE_GIT_ENV,
    });
  } catch (error) {
    const failure = describeGitFailure(error);
    return {
      ok: false,
      action: 'pull',
      reason: failure.reason,
      message: `拉取失败：${failure.message}`,
      files: [],
      repairId: null,
      commits: [],
      status: statusOf(root),
    };
  }

  const upstream = upstreamOf(root, branch, remote);
  if (!upstream) {
    throw new ServiceError('VALIDATION', `远端 ${remote} 上还没有 ${branch} 分支，先推送一次建立上游`);
  }

  try {
    // upstream 是 HEAD 的祖先 ⇒ 没有落后的提交（本地即使领先也不用合并）
    git(root, ['merge-base', '--is-ancestor', upstream, 'HEAD']);
    return {
      ok: true,
      action: 'pull',
      reason: 'ok',
      message: '已经是最新，没有需要拉取的提交',
      files: [],
      repairId: null,
      commits: [],
      status: statusOf(root),
    };
  } catch {
    /* HEAD 不是 upstream 的祖先 → 需要合并 */
  }

  try {
    await gitAsync(root, ['merge', '--no-edit', upstream], { timeoutMs: 120_000 });
    const head = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    return {
      ok: true,
      action: 'pull',
      reason: 'ok',
      message: `拉取完成：${branch} 已更新到 ${head || '最新提交'}`,
      files: [],
      repairId: null,
      commits: [],
      status: statusOf(root),
    };
  } catch (error) {
    const conflicts = unmergedPaths(root);
    if (conflicts.length > 0) return conflictResult(root, 'pull', conflicts, startRepair);
    const failure = describeGitFailure(error);
    return {
      ok: false,
      action: 'pull',
      reason: failure.reason,
      message: `拉取失败：${failure.message}`,
      files: [],
      repairId: null,
      commits: [],
      status: statusOf(root),
    };
  }
}

/* ---------- 推送前：按文件夹生成提交 ---------- */

/** 派生数据 / 系统噪音不进推送前提交（仓库 .gitignore 之外再兜一层） */
const PUSH_STAGE_EXCLUDES = [
  ...AUTO_COMMIT_EXCLUDES,
  ':(exclude).DS_Store',
  ':(exclude,glob)**/.DS_Store',
  ':(exclude)Thumbs.db',
  ':(exclude,glob)**/Thumbs.db',
  ':(exclude)desktop.ini',
  ':(exclude,glob)**/desktop.ini',
  ':(exclude,glob)**/.aidocs/**',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/*.tmp-*',
];

export interface ChangedGroup {
  /** 分组路径（pathspec）：docs/<group>/<artifact>、types/<name>、skills/<name>、. */
  path: string;
  /** 提交摘要里的中文标签 */
  label: string;
  /** 该组包含的变更路径（相对 storageRoot） */
  paths: string[];
}

/**
 * 一个变更路径归属哪个文件夹组：文档到 artifact，类型/技能到各自目录，根文件单独一组。
 * 直接落在 docs/、types/、skills/ 下的散文件按**完整文件路径**成组，避免用 `docs` 这类
 * 前缀路径当 pathspec 时把整棵 docs 都卷进同一个提交。
 */
export function groupKeyOf(file: string): string {
  const parts = file.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return '.';
  if (parts[0] === 'docs') return parts.length >= 3 ? parts.slice(0, 3).join('/') : parts.join('/');
  if (parts[0] === 'types' || parts[0] === 'skills') {
    return parts.length >= 3 ? parts.slice(0, 2).join('/') : parts.join('/');
  }
  if (parts.length === 1) return '.';
  return parts[0]!;
}

function groupLabelOf(key: string): string {
  if (key === '.') return '根目录';
  if (key.startsWith('docs/')) return key.slice('docs/'.length);
  if (key === 'types') return '类型';
  if (key.startsWith('types/')) return `类型 ${key.slice('types/'.length)}`;
  if (key === 'skills') return '技能';
  if (key.startsWith('skills/')) return `技能 ${key.slice('skills/'.length)}`;
  return key;
}

/** 把变更路径按文件夹分组；同一组只保留一次，组按文档 → 类型 → 技能 → 其它 → 根目录排序 */
export function groupChangedPaths(paths: string[]): ChangedGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const file of paths) {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!normalized) continue;
    const key = groupKeyOf(normalized);
    const set = groups.get(key) ?? new Set<string>();
    set.add(normalized);
    groups.set(key, set);
  }
  const rank = (key: string): number =>
    key === '.' ? 4 : key.startsWith('docs/') || key === 'docs' ? 0 : key.startsWith('types/') || key === 'types' ? 1 : key.startsWith('skills/') || key === 'skills' ? 2 : 3;
  return [...groups.entries()]
    .map(([path, files]) => ({ path, label: groupLabelOf(path), paths: [...files] }))
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/** 当前工作区所有变更（含未跟踪文件，展开到文件级，重命名取旧/新两条路径） */
function readChangedPaths(root: string): string[] {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  const fields = out.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.add(path);
    if (status.includes('R') || status.includes('C')) {
      const from = fields[i + 1];
      if (from) paths.add(from);
    }
  }
  return [...paths];
}

function hasStagedChangesAny(root: string): boolean {
  try {
    git(root, ['diff', '--cached', '--quiet']);
    return false;
  } catch {
    return true;
  }
}

/**
 * 推送前把未提交改动按文件夹切成多个提交：
 * 一个 Artifact（docs/<g>/<a>）/ 一个类型 / 一个技能 / 根目录各一个 commit。
 * 返回已经生成的提交；中途失败时保留已提交部分并把错误交给调用方。
 */
export function commitChangesByFolder(root: string): { commits: GitSyncCommit[]; error?: string } {
  const groups = groupChangedPaths(readChangedPaths(root));
  const commits: GitSyncCommit[] = [];
  for (const group of groups) {
    const pathspecs = group.path === '.' ? group.paths : [group.path];
    try {
      git(root, ['add', '-A', '--', ...pathspecs, ...PUSH_STAGE_EXCLUDES], { timeoutMs: 60_000 });
      if (!hasStagedChangesAny(root)) continue;
      const stagedFiles = git(root, ['diff', '--cached', '--name-only']).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean).length;
      const message = `human: ${group.label} · 推送前提交`;
      try {
        git(root, ['commit', '-m', message], { timeoutMs: 60_000 });
      } catch {
        // 没配 git 身份时回退到应用身份（不写全局 config）
        git(root, ['-c', 'user.name=我的文档', '-c', 'user.email=aidocs@localhost', 'commit', '-m', message], {
          timeoutMs: 60_000,
        });
      }
      const sha = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
      commits.push({ path: group.path, label: group.label, sha, files: stagedFiles });
    } catch (error) {
      return { commits, error: `提交「${group.label}」失败：${describeGitFailure(error).message}` };
    }
  }
  return { commits };
}

async function push(root: string, branch: string): Promise<GitSyncResult> {
  const remote = remoteNameOf(root, branch);
  const upstream = upstreamOf(root, branch, remote);
  // 远端分支名通常与本地同名；upstream 指向别的名字时按 upstream 走
  const remoteBranch = upstream && upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : branch;

  // 先把工作区改动按文件夹切成提交；提交失败就不推送，避免把半成品传上去
  const pre = commitChangesByFolder(root);
  if (pre.error) {
    return {
      ok: false,
      action: 'push',
      reason: 'error',
      message: `推送前提交失败：${pre.error}`,
      files: [],
      repairId: null,
      commits: pre.commits,
      status: statusOf(root),
    };
  }
  const commits = pre.commits;

  // 总是带 -u：首次推送建立 tracking，后续推送保持上游配置不漂移
  const args = ['push', '-u', remote, `HEAD:${remoteBranch}`];
  try {
    await gitAsync(root, args, {
      timeoutMs: 120_000,
      env: NON_INTERACTIVE_GIT_ENV,
    });
    const head = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    return {
      ok: true,
      action: 'push',
      reason: 'ok',
      message: `推送完成：${branch} → ${remote}${head ? `（${head}）` : ''}`,
      files: [],
      repairId: null,
      commits,
      status: statusOf(root),
    };
  } catch (error) {
    const failure = describeGitFailure(error);
    if (failure.reason === 'behind') {
      // 推送被拒说明远端已前进；补一次 fetch，把 ↑↓ 状态刷新成真实值
      try {
        await gitAsync(root, ['fetch', '--prune', remote], {
          timeoutMs: 30_000,
          env: NON_INTERACTIVE_GIT_ENV,
        });
      } catch {
        /* 刷新失败不影响错误提示 */
      }
    }
    return {
      ok: false,
      action: 'push',
      reason: failure.reason,
      message: failure.reason === 'behind' ? '远端有新提交，请先拉取再推送' : `推送失败：${failure.message}`,
      files: [],
      repairId: null,
      commits,
      status: statusOf(root),
    };
  }
}

export interface SyncStorageOptions {
  /** 测试注入：默认启动真实 pi 修复任务 */
  startRepair?: StartRepair;
}

/** 拉取 / 推送 storageRoot；冲突时自动启动 pi 修复并返回 repairId */
export async function syncStorage(action: GitSyncAction, options: SyncStorageOptions = {}): Promise<GitSyncResult> {
  const root = resolveStorageRoot();
  if (!isRepo(root)) throw new ServiceError('VALIDATION', '存储目录不是 git 仓库');
  assertRepoRoot(root);
  return withSyncLock(root, async () => {
    if (gitOperationInProgress(root)) {
      throw new ServiceError('CONFLICT', '有未完成的合并或冲突，请先修复或放弃合并');
    }
    const branch = branchOf(root);
    return action === 'pull'
      ? pull(root, branch, options.startRepair ?? startRepairJob)
      : push(root, branch);
  });
}

/** 设置页「放弃本次合并」 */
export function abortCurrentMerge(): GitStatus {
  const root = resolveStorageRoot();
  if (!isRepo(root)) throw new ServiceError('VALIDATION', '存储目录不是 git 仓库');
  assertRepoRoot(root);
  abortMerge(root);
  return statusOf(root);
}

export interface StartRepairResult {
  id: string;
  files: string[];
  /** 没有冲突、只差合并提交时，直接同步完成，不启动 pi */
  committed?: boolean;
  sha?: string | null;
}

/**
 * 设置页的「用 pi 修复 / 完成合并」。
 * 冲突未解决 → 启动 pi；冲突已清空但 MERGE_HEAD 还在 → 直接完成合并提交。
 * 已有在跑任务时返回同一个 id。
 */
export function startCurrentRepair(): StartRepairResult {
  const root = resolveStorageRoot();
  if (!isRepo(root)) throw new ServiceError('VALIDATION', '存储目录不是 git 仓库');
  assertRepoRoot(root);
  if (unmergedPaths(root).length === 0 && gitOperationInProgress(root)) {
    try {
      const sha = completeMerge(root);
      if (!sha) throw new ServiceError('CONFLICT', '没有进行中的合并，无法完成提交');
      return { id: '', files: [], committed: true, sha };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('CONFLICT', `完成合并失败：${(error as Error).message}`, {
        cause: (error as Error).message,
      });
    }
  }
  return startRepairJob(root);
}
