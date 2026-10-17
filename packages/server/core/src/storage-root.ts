import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class StorageRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageRootError';
  }
}

/** 系统目录：无论用户主目录在哪都不允许 */
const SYSTEM_PREFIXES = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private', '/dev', '/Library', '/Applications', '/cores', '/opt'];

/** 允许的根：用户主目录（不含主目录本身）、临时目录、外置卷 */
function allowedRoots(): string[] {
  return [homedir(), tmpdir(), '/tmp', '/Volumes'];
}

function inside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 校验并准备 storageRoot：绝对路径、非系统目录、落在允许范围、可写。
 * 返回规范化后的绝对路径；失败抛 StorageRootError（中文原因）。
 */
export function validateStorageRoot(input: string): string {
  const raw = input.trim();
  if (!raw) throw new StorageRootError('存储目录不能为空');
  if (!isAbsolute(raw)) throw new StorageRootError('请填写绝对路径（以 / 开头）');

  const target = resolve(raw);
  if (target === '/') throw new StorageRootError('不允许使用系统目录：/');
  if (SYSTEM_PREFIXES.some((prefix) => inside(prefix, target))) {
    throw new StorageRootError(`不允许使用系统目录：${target}`);
  }
  if (target === resolve(homedir())) {
    throw new StorageRootError('请不要直接使用用户主目录作为存储目录，请另建子目录');
  }
  if (!allowedRoots().some((root) => inside(root, target))) {
    throw new StorageRootError(`目录不在允许范围（用户主目录、/Volumes 或临时目录）：${target}`);
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new StorageRootError(`不是目录：${target}`);
  }
  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new StorageRootError(`目录不可写：${target}`);
    }
    throw new StorageRootError(`无法创建目录：${target}（${(error as Error).message}）`);
  }
  const probe = join(target, `.aidocs-write-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
  } catch {
    throw new StorageRootError(`目录不可写：${target}`);
  }
  return target;
}
