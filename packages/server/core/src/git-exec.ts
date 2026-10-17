import { execFileSync } from 'node:child_process';

export interface GitResult { stdout: string; stderr: string }

/** git 的唯一执行入口：execFileSync（无 shell 注入面）+ 两个 -c（路径不乱码、字节一致） */
export function git(dir: string, args: string[], opts: { timeoutMs?: number } = {}): GitResult {
  try {
    const stdout = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return { stdout, stderr: '' };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
    throw new GitError(stderr.trim() || e.message || 'git 失败', { dir, args, stderr });
  }
}

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

export function addAll(dir: string, pathspec: string): void {
  git(dir, ['add', '-A', '--', pathspec]);
}

export function hasStagedChanges(dir: string, pathspec: string): boolean {
  try {
    git(dir, ['diff', '--cached', '--quiet', '--', pathspec]);
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
