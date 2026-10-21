import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitResult { stdout: string; stderr: string }

export interface GitOptions {
  timeoutMs?: number;
  /** 追加/覆盖环境变量（网络操作要禁掉 git 的交互式账号密码提示） */
  env?: Record<string, string | undefined>;
}

/** 拉取/推送走它：没有 TTY 时 git 默认会卡在 Credential 提示，直接失败比挂住好 */
export const NON_INTERACTIVE_GIT_ENV: Record<string, string | undefined> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  SSH_ASKPASS_REQUIRE: 'never',
};

const GIT_PREFIX = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false'];

function gitArgs(args: string[]): string[] {
  return [...GIT_PREFIX, ...args];
}

function toGitError(error: unknown, dir: string, args: string[]): GitError {
  const e = error as { stderr?: Buffer | string; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
  return new GitError(stderr.trim() || e.message || 'git 失败', { dir, args, stderr });
}

/** git 的唯一执行入口：execFileSync（无 shell 注入面）+ 两个 -c（路径不乱码、字节一致） */
export function git(dir: string, args: string[], opts: GitOptions = {}): GitResult {
  try {
    const stdout = execFileSync('git', gitArgs(args), {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout, stderr: '' };
  } catch (error) {
    throw toGitError(error, dir, args);
  }
}

/**
 * 异步版：自动提交这类「不在用户请求路径上」的 git 操作走它，
 * 避免 execFileSync 在大仓库里把整个 Node 事件循环按住几秒。
 */
export async function gitAsync(dir: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', gitArgs(args), {
      cwd: dir,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout, stderr };
  } catch (error) {
    throw toGitError(error, dir, args);
  }
}

/** 尚未解决的冲突文件（相对 dir，正斜杠保持 git 原样） */
export function unmergedPaths(dir: string): string[] {
  try {
    return git(dir, ['diff', '--name-only', '--diff-filter=U']).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * merge / rebase / cherry-pick / revert 是否进行中。
 * 自动提交必须让路：合并冲突期间 `git add -A -- docs/...` + `git commit`
 * 可能把半成品或 pi 正在改的文件提前提交成合并提交。
 */
export function gitOperationInProgress(dir: string): boolean {
  try {
    const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']).stdout.trim();
    if (!gitDir) return false;
    return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some((name) =>
      existsSync(join(gitDir, name)),
    );
  } catch {
    return false;
  }
}

/** 自动提交时统一排除的文件（渲染日志是派生数据，不进版本库；兼容旧版共享 ui.jsonl） */
export const AUTO_COMMIT_EXCLUDES = [
  ':(exclude,glob)**/sessions/ui.jsonl',
  ':(exclude,glob)**/sessions/*.ui.jsonl',
];

export class GitError extends Error {
  constructor(message: string, public context: { dir: string; args: string[]; stderr: string }) {
    super(message);
    this.name = 'GitError';
  }
}

export function isRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function isRepoAsync(dir: string): Promise<boolean> {
  try {
    return (await gitAsync(dir, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export function initRepo(dir: string): void {
  git(dir, ['init', '-b', 'main']);
}

export interface StatusEntry { path: string; status: string }

export function statusPorcelain(dir: string, pathspec?: string): StatusEntry[] {
  const args = ['status', '--porcelain'];
  if (pathspec) args.push('--', pathspec);
  return git(dir, args).stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

export function addAll(dir: string, pathspec: string, excludes: string[] = []): void {
  git(dir, ['add', '-A', '--', pathspec, ...excludes]);
}

export function hasStagedChanges(dir: string, pathspec: string, excludes: string[] = []): boolean {
  try {
    git(dir, ['diff', '--cached', '--quiet', '--', pathspec, ...excludes]);
    return false;
  } catch {
    return true;
  }
}

export function commit(dir: string, message: string, pathspec?: string): string {
  const args = ['commit', '-m', message];
  if (pathspec) args.push('--', pathspec);
  git(dir, args);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

export async function addAllAsync(dir: string, pathspec: string, excludes: string[] = []): Promise<void> {
  await gitAsync(dir, ['add', '-A', '--', pathspec, ...excludes]);
}

export async function hasStagedChangesAsync(dir: string, pathspec: string, excludes: string[] = []): Promise<boolean> {
  try {
    await gitAsync(dir, ['diff', '--cached', '--quiet', '--', pathspec, ...excludes]);
    return false;
  } catch {
    return true;
  }
}

export async function commitAsync(
  dir: string,
  message: string,
  pathspec?: string,
  excludes: string[] = [],
): Promise<string> {
  const args = ['commit', '-m', message];
  if (pathspec) args.push('--', pathspec, ...excludes);
  await gitAsync(dir, args);
  return (await gitAsync(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}
