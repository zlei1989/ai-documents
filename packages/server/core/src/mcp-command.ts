import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { McpServer } from '@aidocs/contracts';

/**
 * MCP 命令解析：把 `command` 从「用户写的名字」变成「真能执行的绝对路径」。
 *
 * 为什么不能只靠 `process.env.PATH`：
 *   · 这是个本地应用，从 Finder / 图标启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`；
 *   · uv 默认装在自己家里（`~/.local/bin`），Homebrew 在 `/opt/homebrew/bin`，
 *     shell 里能跑不等于本进程里能找到。
 * 同一份解析同时给「探针」和「真起进程时的 env」用 —— 探针说 ok、会话却起不来，
 * 是最难查的那种不一致。
 */

/** PATH 之外再找的「装完不一定进 PATH」的目录；按 macOS 上最常见的顺序 */
const EXTRA_BIN_DIRS = [
  '~/.local/bin', // uv / uvx / pipx
  '~/.bun/bin', // bunx
  '/opt/homebrew/bin', // Apple Silicon Homebrew
  '/usr/local/bin', // Intel Homebrew / 手工安装
  '~/.cargo/bin',
];

export interface ResolveCommandOptions {
  /** 默认 process.env；测试里可换成一份干净的环境 */
  env?: NodeJS.ProcessEnv;
  /** 默认 EXTRA_BIN_DIRS（已展开 `~`）；测试里可注入临时目录 */
  extraDirs?: readonly string[];
}

/** 展开 `~` 并去重（保留顺序）：探针会把这份列表写进失败原因，用户才知道去哪儿装 */
export function mcpSearchDirs(home: string = homedir()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of EXTRA_BIN_DIRS) {
    const dir = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/**
 * 解析命令：带目录分隔符的按路径看；否则先查 PATH（尊重用户 PATH 的顺序），
 * 再查常见安装目录。找不到返回 null。
 */
export function resolveMcpCommand(
  command: string,
  options: ResolveCommandOptions = {},
): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[\\/]/.test(trimmed)) {
    const candidate = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
    return isExecutable(candidate) ? candidate : null;
  }
  const env = options.env ?? process.env;
  const extraDirs = options.extraDirs ?? mcpSearchDirs();
  const seen = new Set<string>();
  for (const dir of [...(env.PATH ?? '').split(delimiter), ...extraDirs]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, trimmed);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 真正起 MCP 子进程时该给的 env：用户填的 env 原样保留，只把「解析出来的那个目录」
 * 补进 PATH。pi 的 stdio 传输是 `{ ...process.env, ...config.env }`，
 * 不补这一步，`uvx` 在 Finder 启动的宿主里永远找不到。
 */
export function mcpSpawnEnv(
  server: Pick<McpServer, 'command' | 'env'>,
  options: ResolveCommandOptions = {},
): Record<string, string> {
  const env: Record<string, string> = { ...server.env };
  const command = (server.command ?? '').trim();
  if (!command) return env;
  const resolved = resolveMcpCommand(command, options);
  if (!resolved) return env;
  const dir = dirname(resolved);
  const env2 = options.env ?? process.env;
  const inherited = env.PATH ?? env2.PATH ?? '';
  const parts = inherited.split(delimiter).filter((part) => part !== '');
  if (parts.includes(dir)) return env;
  return { ...env, PATH: [dir, ...parts].join(delimiter) };
}
