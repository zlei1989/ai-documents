// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  findMcpLauncher,
  launcherBinName,
  MCP_LAUNCHER_PRESETS,
  missingCommandHint,
  optionTakesValue,
} from './mcp-launcher';

describe('MCP 启动器表', () => {
  it('按可执行名认启动器：带目录、大小写、Windows 后缀都归一', () => {
    expect(launcherBinName('/Users/x/.local/bin/uvx')).toBe('uvx');
    expect(launcherBinName('C:\\tools\\NPX.CMD')).toBe('npx');

    expect(findMcpLauncher('uvx')?.bin).toBe('uvx');
    expect(findMcpLauncher('/opt/homebrew/bin/npx')?.bin).toBe('npx');
    expect(findMcpLauncher('mcp-server-fetch')).toBeNull();
    expect(findMcpLauncher('')).toBeNull();
  });

  it('选项是否带值：--from=x 自带值不用跳，--from x 要把下一个词跳掉', () => {
    expect(optionTakesValue('--from=x')).toBe(false);
    expect(optionTakesValue('--from')).toBe(true);
    expect(optionTakesValue('-p')).toBe(true);
    expect(optionTakesValue('-y')).toBe(false);
    expect(optionTakesValue('mcp-server-fetch')).toBe(false);
  });

  it('缺命令时：已知启动器给安装方式，未知命令才回落到「检查 PATH」', () => {
    const uvx = missingCommandHint('uvx', ['/Users/x/.local/bin']);
    expect(uvx).toContain('uvx');
    expect(uvx).toContain('brew install uv');
    expect(uvx).toContain('/Users/x/.local/bin');

    const unknown = missingCommandHint('my-server');
    expect(unknown).toContain('找不到可执行命令：my-server');
    expect(unknown).toContain('PATH');
  });

  it('表单快捷只给会下包的启动器，python / python3 不占位', () => {
    expect(MCP_LAUNCHER_PRESETS.map((preset) => preset.bin)).toEqual(['npx', 'uvx', 'bunx', 'pipx']);
    // 但 python 仍算已知启动器：缺它时要能说「装 Python」，而不是「检查 PATH」
    expect(findMcpLauncher('python')?.downloads).toBe(false);
    expect(missingCommandHint('python')).toContain('Python');
  });
});
