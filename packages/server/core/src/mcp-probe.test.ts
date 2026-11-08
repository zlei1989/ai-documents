// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServer } from '@aidocs/contracts';
import { probeMcp } from './mcp-probe';

const root = mkdtempSync(join(tmpdir(), 'mcp-probe-'));
const binDir = join(root, 'bin');
mkdirSync(binDir);
// Windows 只认 PATHEXT 里的扩展名；POSIX 用可执行位
const uvxName = process.platform === 'win32' ? 'uvx.cmd' : 'uvx';
const uvxPath = join(binDir, uvxName);
writeFileSync(uvxPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
if (process.platform !== 'win32') chmodSync(uvxPath, 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const uvxServer: McpServer = {
  name: 'time',
  transport: 'stdio',
  command: uvxName,
  args: ['mcp-server-time'],
  env: {},
  headers: {},
  enabled: true,
};

describe('probeMcp：stdio', () => {
  it('启动器解析成功时，说清它是启动器、首次会现下包', async () => {
    const result = await probeMcp(uvxServer, { env: { PATH: '' }, extraDirs: [binDir] });

    expect(result.state).toBe('ok');
    expect(result.reason).toContain(uvxPath);
    expect(result.reason).toContain('uv 的 Python 包启动器');
    expect(result.reason).toContain('首次运行会现下载包');
  });

  it('缺 uv 时直接给安装方式，而不是只说「请检查 PATH」', async () => {
    const result = await probeMcp(uvxServer, { env: { PATH: '' }, extraDirs: [] });

    expect(result.state).toBe('error');
    expect(result.reason).toContain('brew install uv');
  });

  it('未知命令不瞎猜启动器', async () => {
    const result = await probeMcp(
      { ...uvxServer, command: 'no-such-mcp-bin' },
      { env: { PATH: '' }, extraDirs: [] },
    );

    expect(result.state).toBe('error');
    expect(result.reason).toContain('找不到可执行命令：no-such-mcp-bin');
    expect(result.reason).toContain('绝对路径');
  });

  it('缺 command 直接失败', async () => {
    const result = await probeMcp({ ...uvxServer, command: '   ' });
    expect(result).toMatchObject({ state: 'error', reason: '缺少 command' });
  });
});

describe('probeMcp：http', () => {
  it('连不上时给可读原因', async () => {
    const result = await probeMcp({
      ...uvxServer,
      transport: 'http',
      command: undefined,
      url: 'http://127.0.0.1:1/mcp',
    });

    expect(result.state).toBe('error');
    expect(result.reason).toContain('无法连接');
  });
});
