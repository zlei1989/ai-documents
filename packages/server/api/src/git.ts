import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { GitCommit } from '@aidocs/contracts';
import { git, hasStagedChanges, isRepo, readConfig, statusPorcelain } from '@aidocs/core';
import { ServiceError } from './service-error';

function root(): string {
  const storageRoot = readConfig().settings.storageRoot;
  if (!storageRoot) throw new ServiceError('VALIDATION', '尚未配置存储目录');
  if (!isRepo(storageRoot)) throw new ServiceError('VALIDATION', '存储目录不是 git 仓库');
  return storageRoot;
}

function docPath(group: string, name: string): string {
  return join('docs', group, name);
}

export function logCommits(group: string, name: string, limit = 30): GitCommit[] {
  const storageRoot = root();
  const out = git(storageRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x09%h%x09%at%x09%an%x09%s',
    '--',
    docPath(group, name),
  ]).stdout;
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, at, author, ...rest] = line.split('\t');
      const summary = rest.join('\t');
      const origin = summary.startsWith('ai:') ? 'ai' : summary.startsWith('human:') ? 'human' : 'other';
      return {
        sha: sha!,
        shortSha: shortSha!,
        at: new Date(Number(at) * 1000).toISOString(),
        author: author!,
        summary,
        origin: origin as GitCommit['origin'],
      };
    });
}

export function diffCommit(group: string, name: string, sha: string): string {
  const storageRoot = root();
  try {
    return git(storageRoot, ['show', '--format=', '--', docPath(group, name)], { timeoutMs: 20_000 }).stdout;
  } catch {
    // show <sha> 需要把 sha 放进参数顺序里，上面那条是 HEAD；显式再来一次
    return git(storageRoot, ['show', sha, '--format=', '--', docPath(group, name)], { timeoutMs: 20_000 }).stdout;
  }
}

export interface RollbackResult { sha: string; committed: boolean }

export function rollbackTo(group: string, name: string, sha: string): RollbackResult {
  const storageRoot = root();
  const storageAbs = resolve(storageRoot);
  const rel = relative(storageAbs, resolve(storageRoot, docPath(group, name)));
  if (rel.startsWith('..') || !existsSync(join(storageRoot, rel))) throw new ServiceError('NOT_FOUND', '文档目录不存在');

  const dirty = statusPorcelain(storageRoot, rel);
  if (dirty.length > 0) {
    throw new ServiceError('CONFLICT', '工作区有未提交改动，请先提交再回滚', { dirty: dirty.slice(0, 10) });
  }

  try {
    git(storageRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw new ServiceError('NOT_FOUND', `提交不存在：${sha}`);
  }

  git(storageRoot, ['checkout', sha, '--', rel]);
  if (!hasStagedChanges(storageRoot, rel)) {
    return { sha: git(storageRoot, ['rev-parse', 'HEAD']).stdout.trim(), committed: false };
  }
  git(storageRoot, ['-c', 'user.name=我的文档', '-c', 'user.email=我的文档@local', 'commit', '-m', `rollback: ${group}/${name} → ${sha.slice(0, 7)}`, '--', rel]);
  const head = git(storageRoot, ['rev-parse', 'HEAD']).stdout.trim();
  return { sha: head, committed: true };
}
