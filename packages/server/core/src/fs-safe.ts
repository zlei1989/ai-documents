import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(target: string) {
    super(`路径越界：${target}`);
  }
}

/**
 * 对不存在的尾段容忍的 realpath：对最近存在的祖先做 realpath，再拼回剩余段。
 * root 与 target 因此总在同一命名空间比较（macOS 的 /var → /private/var 不会误判）。
 */
function realpathTolerant(target: string): string {
  const abs = resolve(target);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathTolerant(parent), basename(abs));
}

/** target 必须落在 root 内（realpath 校验，容忍末尾不存在）；返回真实路径 */
export function assertInside(root: string, target: string): string {
  const rootReal = realpathTolerant(resolve(root));
  const targetReal = realpathTolerant(resolve(target));
  const rel = relative(rootReal, targetReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathEscapeError(target);
  return targetReal;
}

/** 最深已存在前缀取 realpath，再接回不存在的尾段 */
function realpathPrefix(target: string): string {
  const missing: string[] = [];
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return target;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
}

/** 同步小睡：Windows 上 rename 偶尔被索引器/杀毒短暂占用，重试前让出一下 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows 的 rename 可能瞬时 EPERM/EBUSY（目标文件正被杀毒/索引器打开）；短暂重试 */
function renameOverwrite(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= 4) {
        try {
          unlinkSync(tmp);
        } catch {
          /* 清理失败不掩盖原错误 */
        }
        throw error;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

/** 原子写文本：临时文件 + rename，容忍并发读者 */
export function atomicWrite(file: string, data: string, opts: { mode?: number } = {}): void {
  atomicWriteBuffer(file, Buffer.from(data, 'utf8'), opts);
}

/** 原子写二进制：图片等资源用；同样临时文件 + rename */
export function atomicWriteBuffer(file: string, data: Buffer | Uint8Array, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: opts.mode });
  renameOverwrite(tmp, file);
}
