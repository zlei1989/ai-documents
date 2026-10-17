// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mcpSpawnEnv, resolveMcpCommand } from './mcp-command';

const root = mkdtempSync(join(tmpdir(), 'mcp-command-'));
const binDir = join(root, 'bin');
mkdirSync(binDir);
const uvxPath = join(binDir, 'uvx');
writeFileSync(uvxPath, '#!/bin/sh\nexit 0\n');
chmodSync(uvxPath, 0o755);
const plainFile = join(binDir, 'not-executable');
writeFileSync(plainFile, 'x');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('resolveMcpCommand', () => {
  it('PATH 里没有时，去常见安装目录（用例注入临时目录）再找一次', () => {
    expect(resolveMcpCommand('uvx', { env: { PATH: '' }, extraDirs: [binDir] })).toBe(uvxPath);
  });

  it('PATH 命中就用 PATH 的结果，顺序按 PATH 来', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    const otherUvx = join(other, 'uvx');
    writeFileSync(otherUvx, '#!/bin/sh\nexit 0\n');
    chmodSync(otherUvx, 0o755);

    expect(resolveMcpCommand('uvx', { env: { PATH: `${binDir}:${other}` }, extraDirs: [] })).toBe(uvxPath);
    expect(resolveMcpCommand('uvx', { env: { PATH: other }, extraDirs: [binDir] })).toBe(otherUvx);
  });

  it('不可执行、找不到、空命令都是 null', () => {
    expect(resolveMcpCommand('not-executable', { env: { PATH: binDir }, extraDirs: [] })).toBeNull();
    expect(resolveMcpCommand('uvx', { env: { PATH: '' }, extraDirs: [] })).toBeNull();
    expect(resolveMcpCommand('  ', { env: { PATH: binDir }, extraDirs: [binDir] })).toBeNull();
  });

  it('带目录分隔符的命令按路径解析，相对路径按 cwd 展开', () => {
    expect(resolveMcpCommand(uvxPath, { env: { PATH: '' } })).toBe(uvxPath);
    expect(resolveMcpCommand('/nope/uvx', { env: { PATH: '' } })).toBeNull();
  });
});

describe('mcpSpawnEnv', () => {
  it('把解析到的目录补进 PATH，用户自己写的 env 原样保留', () => {
    const env = mcpSpawnEnv(
      { command: 'uvx', env: { FOO: 'bar' } },
      { env: { PATH: '/usr/bin:/bin' }, extraDirs: [binDir] },
    );

    expect(env.FOO).toBe('bar');
    expect(env.PATH?.split(':')[0]).toBe(binDir);
    expect(env.PATH).toContain('/usr/bin');
  });

  it('已经在 PATH 里就不重复添加', () => {
    const env = mcpSpawnEnv(
      { command: 'uvx', env: {} },
      { env: { PATH: `${binDir}:/usr/bin` }, extraDirs: [] },
    );

    expect(env).toEqual({});
  });

  it('解析不到时不动 env（不留半截 PATH）', () => {
    const env = mcpSpawnEnv(
      { command: 'uvx', env: { FOO: 'bar' } },
      { env: { PATH: '/usr/bin' }, extraDirs: [] },
    );

    expect(env).toEqual({ FOO: 'bar' });
  });
});
