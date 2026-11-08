import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import type { McpServer } from '@aidocs/contracts';

/**
 * MCP 命令解析：把 `command` 从「用户写的名字」变成「真能执行的绝对路径」。
 *
 * 为什么不能只靠 `process.env.PATH`：
 *   · 这是个本地应用，从 Finder / 桌面图标启动时 PATH 往往只有系统最小集合；
 *   · uv 默认装在自己家里（`~/.local/bin`），Homebrew 在 `/opt/homebrew/bin`，
 *     Windows 的 npm / pnpm 全局包在 `%APPDATA%\npm` 一类目录里；shell 里能跑不等于本进程里能找到。
 * 同一份解析同时给「探针」和「真起进程时的 env」用 —— 探针说 ok、会话却起不来，
 * 是最难查的那种不一致。
 */

const isWindows = process.platform === 'win32';

/** Windows 上 PATH 查找要按 PATHEXT 补扩展名；用户环境缺这个变量时用系统默认值 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** PATH 之外再找的「装完不一定进 PATH」的目录；按平台给最常见的位置 */
function platformBinDirs(env: NodeJS.ProcessEnv): string[] {
  if (isWindows) {
    return [
      '~/.local/bin', // uv / uvx / pipx
      '~/.bun/bin', // bunx
      '~/.cargo/bin',
      env.APPDATA ? join(env.APPDATA, 'npm') : '~/AppData/Roaming/npm', // npm -g
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'pnpm') : '~/AppData/Local/pnpm', // pnpm global
      '~/scoop/shims',
    ];
  }
  return [
    '~/.local/bin', // uv / uvx / pipx
    '~/.bun/bin', // bunx
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew / 手工安装
    '~/.cargo/bin',
    '/usr/bin',
  ];
}

export interface ResolveCommandOptions {
  /** 默认 process.env；测试里可换成一份干净的环境 */
  env?: NodeJS.ProcessEnv;
  /** 默认 EXTRA_BIN_DIRS（已展开 `~`）；测试里可注入临时目录 */
  extraDirs?: readonly string[];
}

/** Windows 的 env 键大小写不敏感（常见 `Path` 而不是 `PATH`） */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** 当前平台可执行文件的扩展名；POSIX 返回空数组（用 X_OK 判断） */
function executableExtensions(env: NodeJS.ProcessEnv): string[] {
  if (!isWindows) return [];
  const raw = envValue(env, 'PATHEXT') || DEFAULT_PATHEXT;
  return [...new Set(raw.split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean))];
}

/** `uvx` ⇒ `uvx`、`uvx.com`、`uvx.exe`…（Windows）；已带扩展名或非 Windows 只试本身 */
function candidateNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (!isWindows || extname(command)) return [command];
  return [command, ...executableExtensions(env).map((ext) => `${command}${ext}`)];
}

/** PATH 串 → 目录列表；去掉空项与个别安装器留下的引号 */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATH') ?? '')
    .split(delimiter)
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part !== '');
}

/** 展开 `~` 并去重（保留顺序）：探针会把这份列表写进失败原因，用户才知道去哪儿装 */
export function mcpSearchDirs(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const raw = [...platformBinDirs(env), dirname(process.execPath)];
  for (const entry of raw) {
    const dir = entry.startsWith('~/') || entry.startsWith('~\\') ? join(home, entry.slice(2)) : entry;
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
  const env = options.env ?? process.env;

  if (/[\\/]/.test(trimmed)) {
    const candidate = resolve(trimmed);
    return findExecutable(dirname(candidate), basename(candidate), env);
  }

  const extraDirs = options.extraDirs ?? mcpSearchDirs();
  const seen = new Set<string>();
  for (const dir of [...pathDirs(env), ...extraDirs]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const found = findExecutable(dir, trimmed, env);
    if (found) return found;
  }
  return null;
}

function findExecutable(dir: string, name: string, env: NodeJS.ProcessEnv): string | null {
  for (const candidate of candidateNames(name, env)) {
    const file = join(dir, candidate);
    if (isExecutable(file, env)) return file;
  }
  return null;
}

function isExecutable(file: string, env: NodeJS.ProcessEnv): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (isWindows) {
      // Windows 没有 POSIX 的 x 位：能当命令跑的只有 PATHEXT 里的扩展名（.exe/.cmd/.bat…）
      return executableExtensions(env).includes(extname(file).toLowerCase());
    }
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 真正起 MCP 子进程时该给的 env：用户填的 env 原样保留，只把「解析出来的那个目录」
 * 补进 PATH。pi 的 stdio 传输是 `{ ...process.env, ...config.env }`，
 * 不补这一步，`uvx` 在 Finder / 桌面图标启动的宿主里永远找不到。
 */
export function mcpSpawnEnv(
  server: Pick<McpServer, 'command' | 'env'>,
  options: ResolveCommandOptions = {},
): Record<string, string> {
  // Windows 的 env 键大小写不敏感：先去掉用户写的 path/PATH，避免出现两份 PATH
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = value;
  }
  const command = (server.command ?? '').trim();
  if (!command) return env;
  const resolved = resolveMcpCommand(command, options);
  if (!resolved) return env;
  const dir = dirname(resolved);
  const parts = pathDirs(options.env ?? process.env);
  if (parts.includes(dir)) return env;
  return { ...env, PATH: [dir, ...parts].join(delimiter) };
}
