import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';

export class StorageRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageRootError';
  }
}

/** 绝对路径示例按平台给，不写死 `/Users/...` */
const ABSOLUTE_PATH_HINT =
  process.platform === 'win32'
    ? '请填写绝对路径（例如 D:\\我的文档 或 \\\\服务器\\共享\\我的文档）'
    : '请填写绝对路径（例如 /Users/you/我的文档 或 /home/you/我的文档）';

/** 把 `~`、`~/x`、`~\x` 展开成用户主目录；其余原样返回 */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

/**
 * 只校验路径本身（不做 IO）：非空、绝对路径、不是磁盘/共享根目录。
 * 返回 `resolve` 后的平台路径；三端都用 `node:path`，不写死 `/` 或盘符。
 */
export function resolveStoragePath(input: string): string {
  const raw = expandHomePath(input.trim());
  if (!raw) throw new StorageRootError('存储目录不能为空');
  if (raw.includes('\0')) throw new StorageRootError('存储目录不能包含空字符');
  if (!isAbsolute(raw)) throw new StorageRootError(ABSOLUTE_PATH_HINT);

  const target = resolve(raw);
  // `/`、`D:\`、`\\server\share\` 这类根目录：git init 会把整个卷当仓库，明确拒绝
  if (target === parse(target).root) {
    throw new StorageRootError(`不能把磁盘根目录当作存储目录：${target}`);
  }
  return target;
}

/**
 * 校验并准备 storageRoot。
 *
 * 只做「这个路径能不能当目录用」的检查：路径合法、是（可创建的）目录、可写。
 * **不限制存放位置**：Windows 的任意盘符、UNC 共享，macOS / Linux 的任意可写目录都可以。
 * 返回规范化后的绝对路径；失败抛 StorageRootError（中文原因）。
 */
export function validateStorageRoot(input: string): string {
  const target = resolveStoragePath(input);
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
    if (code === 'ENOTDIR') throw new StorageRootError(`不是目录：${target}`);
    throw new StorageRootError(`无法创建目录：${target}（${(error as Error).message}）`);
  }

  // 真写一个探针文件：Windows 上目录 ACL 与只读属性比 accessSync 可靠
  const probe = join(target, `.aidocs-write-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, 'ok', 'utf8');
  } catch {
    throw new StorageRootError(`目录不可写：${target}`);
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      /* 探针没写成功时不存在，忽略 */
    }
  }
  return target;
}
