import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GitCommit, StorageState } from '@aidocs/contracts';
import {
  PathEscapeError,
  addAll,
  assertInside,
  commit,
  git,
  hasStagedChanges,
  initRepo,
  isRepo,
  readConfig,
} from '@aidocs/core';
import { ServiceError } from './service-error';

export interface StorageStatus {
  /** 绝对路径；未配置时为空串 */
  root: string;
  configured: boolean;
  exists: boolean;
  isRepo: boolean;
  commitCount: number;
  recentCommits: GitCommit[];
  dirty: boolean;
}

const GITIGNORE_HEADER = '# 我的文档';
const GITIGNORE_RULES = ['.DS_Store', 'node_modules/', '.trash/', '.aidocs/'];

/** 配置里的 storageRoot（可能为空，不抛错） */
export function configuredStorageRoot(): string {
  return readConfig().settings.storageRoot.trim();
}

/** 解析并校验 storageRoot：未配置时抛 VALIDATION（中文原因） */
export function resolveStorageRoot(): string {
  const root = configuredStorageRoot();
  if (!root) throw new ServiceError('VALIDATION', '尚未配置存储根目录，请先在设置页填写 storageRoot');
  return resolve(root);
}

/** 名称即目录名（允许中文）；拒绝路径分隔符、穿越片段与隐藏目录 */
export function assertValidName(name: string, kind = '名称'): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ServiceError('VALIDATION', `${kind}不能为空`);
  if (trimmed !== name) throw new ServiceError('VALIDATION', `${kind}首尾不能有空白`);
  if (/[/\\\u0000-\u001f]/.test(trimmed)) throw new ServiceError('VALIDATION', `${kind}不能包含路径分隔符或控制字符`);
  if (trimmed === '.' || trimmed === '..') throw new ServiceError('VALIDATION', `${kind}不合法`);
  if (trimmed.startsWith('.')) throw new ServiceError('VALIDATION', `${kind}不能以 . 开头`);
  if (trimmed.length > 80) throw new ServiceError('VALIDATION', `${kind}过长（最多 80 字）`);
  return trimmed;
}

/** 所有落盘路径的护栏：必须落在 storageRoot 内，越界抛 VALIDATION（真实路径校验在 core） */
export function assertInsideRoot(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, target);
  try {
    assertInside(rootAbs, targetAbs);
    return targetAbs;
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw new ServiceError('VALIDATION', `路径越界：${target}`, { root, target });
    }
    throw error;
  }
}

/** 时间戳后缀：回收站里同名文件不互相覆盖 */
export function trashStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 软删除：移动到 <root>/.trash/<trashRel>，并把 .trash/ 写进 .gitignore */
export function softDelete(root: string, absPath: string, trashRel: string): string {
  const source = assertInsideRoot(root, absPath);
  if (!existsSync(/*turbopackIgnore: true*/ source)) throw new ServiceError('NOT_FOUND', '要删除的路径不存在');
  const trashRoot = join(resolve(root), '.trash');
  const target = assertInsideRoot(root, join(trashRoot, trashRel));
  ensureTrashIgnored(root);
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ServiceError('INTERNAL', '移入回收站失败', { code, detail: String(error) });
  }
  return target;
}

function ensureGitignore(root: string): void {
  const file = join(root, '.gitignore');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_RULES.filter((rule) => !lines.has(rule));
  if (missing.length === 0) return;
  const body = existing ? `${existing.replace(/\n*$/, '\n')}${missing.join('\n')}\n` : `${GITIGNORE_HEADER}\n${GITIGNORE_RULES.join('\n')}\n`;
  writeFileSync(file, body, 'utf8');
}

/** 回收站目录必须被 git 忽略（软删除不进入版本历史） */
export function ensureTrashIgnored(root: string): void {
  ensureGitignore(root);
}

function commitWithIdentity(dir: string, message: string, pathspec?: string): string {
  try {
    return commit(dir, message, pathspec);
  } catch {
    const args = ['-c', 'user.name=我的文档', '-c', 'user.email=aidocs@localhost', 'commit', '-m', message];
    if (pathspec) args.push('--', pathspec);
    git(dir, args);
    return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  }
}

/**
 * 限定路径的自动提交：无变更不提交；非 git 仓库返回 null。
 * 未配置 git 身份时回退到 我的文档（不写全局 config）。
 */
export function commitPath(root: string, relPath: string, message: string): string | null {
  if (!isRepo(root)) return null;
  addAll(root, relPath);
  if (!hasStagedChanges(root, relPath)) return null;
  return commitWithIdentity(root, message, relPath);
}

export function classifyOrigin(summary: string): GitCommit['origin'] {
  if (/^ai[:：]/.test(summary)) return 'ai';
  if (/^human[:：]/.test(summary)) return 'human';
  return 'other';
}

export function recentCommits(root: string, limit = 5): GitCommit[] {
  if (!isRepo(root)) return [];
  let stdout: string;
  try {
    stdout = git(root, [
      'log',
      `-n${limit}`,
      '--pretty=format:%H%x1f%h%x1f%aI%x1f%an%x1f%s',
    ]).stdout;
  } catch {
    return []; // 空仓库（无 HEAD）
  }
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', at = '', author = '', summary = ''] = line.split('\x1f');
      return { sha, shortSha, at, author, summary, origin: classifyOrigin(summary) };
    })
    .filter((entry) => entry.sha.length > 0);
}

export function commitCount(root: string): number {
  if (!isRepo(root)) return 0;
  try {
    return Number.parseInt(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** git 状态 + 最近提交（UI 的「最近提交」与「⎇ N 个版本」） */
export function storageStatus(root = configuredStorageRoot()): StorageStatus {
  const configured = Boolean(root);
  const abs = configured ? resolve(root) : '';
  const exists = configured && existsSync(abs);
  const repo = exists && isRepo(abs);
  return {
    root: abs,
    configured,
    exists,
    isRepo: repo,
    commitCount: repo ? commitCount(abs) : 0,
    recentCommits: repo ? recentCommits(abs) : [],
    dirty: repo ? git(abs, ['status', '--porcelain']).stdout.trim().length > 0 : false,
  };
}

/** 显式初始化版本历史（绝不在设置/首次进入时静默 init）：git init -b main + 首次提交 */
export function initStorage(root = resolveStorageRoot()): StorageStatus {
  const abs = resolve(root);
  mkdirSync(abs, { recursive: true });
  ensureGitignore(abs);
  if (!isRepo(abs)) initRepo(abs);
  addAll(abs, '.');
  if (hasStagedChanges(abs, '.')) commitWithIdentity(abs, 'init: 初始化存储版本历史');
  return storageStatus(abs);
}

/* ---------- 设置页需要的存储状态包装（来自 M2） ---------- */

import { ensureRepoWithFirstCommit, gitStatus, validateStorageRoot } from '@aidocs/core';
import { getSettings, saveSettings } from './settings';

export function getStorageState(): StorageState {
  const { storageRoot } = getSettings();
  return { storageRoot, git: gitStatus(storageRoot) };
}

export function setStorageRoot(input: string): StorageState {
  let root: string;
  try {
    root = validateStorageRoot(input);
  } catch (error) {
    throw new ServiceError('VALIDATION', (error as Error).message);
  }
  saveSettings({ storageRoot: root });
  return getStorageState();
}

export function initStorageGit(): StorageState {
  const { storageRoot } = getSettings();
  if (!storageRoot) throw new ServiceError('VALIDATION', '请先选择存储目录');
  try {
    ensureRepoWithFirstCommit(storageRoot);
  } catch (error) {
    throw new ServiceError('INTERNAL', `初始化版本历史失败：${(error as Error).message}`, {
      cause: (error as Error).message,
    });
  }
  return getStorageState();
}
