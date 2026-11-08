import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 同步小睡；测试清理用，不引入异步 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 测试专用：删除临时目录。
 *
 * Windows 上 git 会把 `.git/objects/**` 里的包文件标记为只读，`rmSync({ recursive })`
 * 遇到只读子文件会直接 EPERM；先递归清掉只读属性再删。POSIX 上就是普通 rmSync。
 * 另外 Windows 上刚跑完 git 的目录偶尔会被短暂占用，整轮重试几次。
 */
export function removeDirSync(dir: string): void {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!existsSync(dir)) return;
    if (process.platform === 'win32') clearReadOnly(dir);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
      if (attempt >= 5 || !retryable) throw error;
      sleepSync(200 * (attempt + 1));
    }
  }
}

function clearReadOnly(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      clearReadOnly(target);
      continue;
    }
    try {
      chmodSync(target, 0o666);
    } catch {
      /* 权限问题留给 rmSync 报错 */
    }
  }
}
