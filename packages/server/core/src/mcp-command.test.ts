// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mcpSearchDirs, mcpSpawnEnv, resolveMcpCommand } from './mcp-command';

const isWindows = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'mcp-command-'));
const binDir = join(root, 'bin');
mkdirSync(binDir);
// Windows 只认 PATHEXT 里的扩展名；POSIX 用可执行位
const uvxName = isWindows ? 'uvx.cmd' : 'uvx';
const uvxPath = join(binDir, uvxName);
writeFileSync(uvxPath, isWindows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
if (!isWindows) chmodSync(uvxPath, 0o755);
const plainFile = join(binDir, 'not-executable');
writeFileSync(plainFile, 'x');

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 按当前平台拼 PATH：Windows 是 `;`，POSIX 是 `:` */
function pathOf(...dirs: string[]): string {
  return dirs.join(delimiter);
}

describe('resolveMcpCommand', () => {
  it('PATH 里没有时，去常见安装目录（用例注入临时目录）再找一次', () => {
    expect(resolveMcpCommand(uvxName, { env: { PATH: '' }, extraDirs: [binDir] })).toBe(uvxPath);
  });

  it('PATH 命中就用 PATH 的结果，顺序按 PATH 来', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    const otherUvx = join(other, uvxName);
    writeFileSync(otherUvx, isWindows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    if (!isWindows) chmodSync(otherUvx, 0o755);

    expect(resolveMcpCommand(uvxName, { env: { PATH: pathOf(binDir, other) }, extraDirs: [] })).toBe(uvxPath);
    expect(resolveMcpCommand(uvxName, { env: { PATH: other }, extraDirs: [binDir] })).toBe(otherUvx);
  });

  it('不可执行、找不到、空命令都是 null', () => {
    expect(resolveMcpCommand('not-executable', { env: { PATH: binDir }, extraDirs: [] })).toBeNull();
    expect(resolveMcpCommand(uvxName, { env: { PATH: '' }, extraDirs: [] })).toBeNull();
    expect(resolveMcpCommand('  ', { env: { PATH: binDir }, extraDirs: [binDir] })).toBeNull();
  });

  it('带目录分隔符的命令按路径解析，相对路径按 cwd 展开', () => {
    expect(resolveMcpCommand(uvxPath, { env: { PATH: '' } })).toBe(uvxPath);
    expect(resolveMcpCommand(join(root, 'nope', uvxName), { env: { PATH: '' } })).toBeNull();
  });

  it('只在 PATH 里给 uvx（不带扩展名）时，Windows 按 PATHEXT 找到 uvx.cmd', () => {
    expect(resolveMcpCommand('uvx', { env: { PATH: binDir }, extraDirs: [] })).toBe(uvxPath);
  });

  it('常见安装目录列表按平台展开 ~，且包含当前 Node 所在目录', () => {
    const dirs = mcpSearchDirs('/home/tester');
    expect(dirs).toContain(join('/home/tester', '.local', 'bin'));
    expect(dirs.every((dir) => !dir.startsWith('~'))).toBe(true);
  });
});

describe('mcpSpawnEnv', () => {
  it('把解析到的目录补进 PATH，用户自己写的 env 原样保留', () => {
    const env = mcpSpawnEnv(
      { command: uvxName, env: { FOO: 'bar' } },
      { env: { PATH: pathOf('/usr/bin', '/bin') }, extraDirs: [binDir] },
    );

    expect(env.FOO).toBe('bar');
    expect(env.PATH?.split(delimiter)[0]).toBe(binDir);
    expect(env.PATH).toContain('/usr/bin');
  });

  it('已经在 PATH 里就不重复添加', () => {
    const env = mcpSpawnEnv(
      { command: uvxName, env: {} },
      { env: { PATH: pathOf(binDir, '/usr/bin') }, extraDirs: [] },
    );

    expect(env).toEqual({});
  });

  it('解析不到时不动 env（不留半截 PATH）', () => {
    const env = mcpSpawnEnv(
      { command: uvxName, env: { FOO: 'bar' } },
      { env: { PATH: '/usr/bin' }, extraDirs: [] },
    );

    expect(env).toEqual({ FOO: 'bar' });
  });

  it('用户写的 env 里有 Path（Windows 常见大小写）时不保留第二份 PATH', () => {
    const env = mcpSpawnEnv(
      { command: uvxName, env: { Path: 'C:\\custom' } },
      { env: { PATH: pathOf('/usr/bin') }, extraDirs: [binDir] },
    );

    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(env.PATH).toContain(binDir);
  });
});
