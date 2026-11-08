/**
 * MCP 启动器（launcher）的事实表：`npx` / `uvx` / `bunx` / `pipx` / `python -m` 这类
 * 「先解析一个包、再起一个真正干活的服务端」的命令。
 *
 * 为什么单拎出来：同一条 `command: "uvx"` 的含义在三个地方不一样 ——
 *   · 设置页要知道该给什么示例参数、缺了该提示装什么；
 *   · 粘贴导入猜名字时要跳过 `--from` 这类「选项的值」，别把包名猜成 `from`；
 *   · 探针失败时要能直说「不是配置写错了，是这台机器没装 uv」。
 * 三处读同一份表，说法才不会各写一套。
 *
 * 纯数据 + 纯函数：没有 IO、没有 PATH 探测（那在 `@aidocs/core` 的 `mcp-command.ts`）。
 */

export interface McpLauncher {
  /** PATH 里的可执行名（不含目录） */
  bin: string;
  /** 简短中文说明，用在提示里 */
  label: string;
  /** 缺失时给用户的一条安装指引（按 Windows / macOS / Linux 三种写法） */
  install: string;
  /** 设置页「快捷」按钮填的示例参数 */
  exampleArgs: readonly string[];
  /** 首次运行会不会现下载包：决定探针成功时的措辞 */
  downloads: boolean;
}

export const MCP_LAUNCHERS: readonly McpLauncher[] = [
  {
    bin: 'npx',
    label: 'Node 包启动器',
    install: 'npx 随 Node 提供（需要 Node ≥ 22.19）',
    exampleArgs: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    downloads: true,
  },
  {
    bin: 'uvx',
    label: 'uv 的 Python 包启动器',
    install:
      '先装 uv：Windows 用 winget install astral-sh.uv，macOS 用 brew install uv，Linux 用 curl -LsSf https://astral.sh/uv/install.sh | sh；装完在 ~/.local/bin（Windows 是 %USERPROFILE%\\.local\\bin）',
    exampleArgs: ['mcp-server-fetch'],
    downloads: true,
  },
  {
    bin: 'bunx',
    label: 'Bun 包启动器',
    install:
      '先装 bun：Windows 用 winget install Oven-sh.Bun，macOS 用 brew install bun，Linux 用 curl -fsSL https://bun.sh/install | bash',
    exampleArgs: ['@modelcontextprotocol/server-filesystem', '.'],
    downloads: true,
  },
  {
    bin: 'pipx',
    label: 'pipx 的 Python 应用启动器',
    install:
      '先装 pipx：Windows 用 py -m pip install --user pipx，macOS 用 brew install pipx，Linux 用 python3 -m pip install --user pipx',
    exampleArgs: ['run', 'mcp-server-fetch'],
    downloads: true,
  },
  {
    bin: 'python3',
    label: 'Python 解释器（-m 直接跑模块）',
    install: '需要 Python ≥ 3.10，且模块已装在这个解释器的环境里（更省事的是 uvx）',
    exampleArgs: ['-m', 'mcp_server_fetch'],
    downloads: false,
  },
  {
    // 不少人直接写 `python`（venv 里很常见）；和 python3 同一套说法，只是可执行名不同
    bin: 'python',
    label: 'Python 解释器（-m 直接跑模块）',
    install: '需要 Python ≥ 3.10，且模块已装在这个解释器的环境里（更省事的是 uvx）',
    exampleArgs: ['-m', 'mcp_server_fetch'],
    downloads: false,
  },
];

/** 表单「快捷」只列真正会去下载包的启动器；python / python3 要预先装好模块，不适合当一键模板 */
export const MCP_LAUNCHER_PRESETS: readonly McpLauncher[] = MCP_LAUNCHERS.filter(
  (launcher) => !launcher.bin.startsWith('python'),
);

/** 选项名 → 它的值要跳过。漏一个的代价是包名被猜成选项值（`uvx --from x git-mcp` ⇒ `x`） */
const VALUE_OPTIONS = new Set([
  '--from',
  '--with',
  '--python',
  '-p',
  '--index',
  '--index-url',
  '--extra-index-url',
  '--find-links',
  '-f',
  '--config-file',
  '-c',
  '--cache-dir',
  '--directory',
  '--registry',
  '--package',
  '--node-options',
  '--require',
  '-r',
  '--env-file',
]);

/** 去掉目录、小写、去掉 Windows 的 .exe/.cmd 后缀：`/Users/x/.local/bin/UVX` ⇒ `uvx` */
export function launcherBinName(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? command.trim();
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** 这台命令是不是已知启动器；不是则 null（普通二进制照样能配，只是没有针对性提示） */
export function findMcpLauncher(command: string): McpLauncher | null {
  const bin = launcherBinName(command);
  if (bin === '') return null;
  return MCP_LAUNCHERS.find((launcher) => launcher.bin === bin) ?? null;
}

/**
 * 逗号/空格分隔的选项值判断：`--from=x` 是自带值的写法，不用往后跳；
 * `--from x` 才要把下一个词当值跳掉。
 */
export function optionTakesValue(arg: string): boolean {
  if (!arg.startsWith('-')) return false;
  const eq = arg.indexOf('=');
  if (eq > 0) return false;
  return VALUE_OPTIONS.has(arg);
}

/**
 * 找不到可执行文件时给用户的说法。
 * 已知启动器就直接给安装方式 —— 用户配的是 `uvx`，报「请检查 PATH」等于让他自己猜。
 */
export function missingCommandHint(command: string, searchedDirs: readonly string[] = []): string {
  const launcher = findMcpLauncher(command);
  const where = searchedDirs.length > 0 ? `（找过 PATH 与 ${searchedDirs.join(' / ')}）` : '';
  if (launcher) {
    return `找不到可执行命令：${launcher.bin}${where}。${launcher.label}缺失：${launcher.install}`;
  }
  return `找不到可执行命令：${command}${where}（请检查 PATH，或填写绝对路径）`;
}
