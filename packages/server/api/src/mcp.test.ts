import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@aidocs/contracts';
import { deleteMcpServer, importMcpServers, importMcpServersFromText, listMcpServers, probeMcpServer, saveMcpServer } from './mcp';
import { ServiceError } from './service-error';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;

beforeEach(() => {
  env = isolateConfigDir();
});
afterEach(() => {
  env.restore();
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  throw new Error('期望抛出 ServiceError，但没有抛错');
}

function stdio(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: 'context7',
    transport: 'stdio',
    command: 'node',
    args: ['-y', '@upstash/context7-mcp'],
    env: { API_KEY: 'x' },
    headers: {},
    enabled: true,
    ...overrides,
  };
}

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('MCP 配置', () => {
  it('新增、重名更新、列出、删除', () => {
    const saved = saveMcpServer(stdio());
    expect(saved.name).toBe('context7');
    expect(listMcpServers()).toHaveLength(1);

    saveMcpServer(stdio({ args: ['-y', 'changed'], env: {} }));
    const list = listMcpServers();
    expect(list).toHaveLength(1);
    expect(list[0]?.args).toEqual(['-y', 'changed']);

    deleteMcpServer('context7');
    expect(listMcpServers()).toHaveLength(0);
  });

  it('缺少 command 或 url 时给中文校验错误', () => {
    expect(() => saveMcpServer(stdio({ command: undefined }))).toThrowError(/stdio.*command/);
    expect(codeOf(() => saveMcpServer(stdio({ command: undefined })))).toBe('VALIDATION');
    expect(() => saveMcpServer(stdio({ transport: 'http' }))).toThrowError(/http.*url/);
  });

  it('删除不存在的配置给 NOT_FOUND', () => {
    expect(codeOf(() => deleteMcpServer('missing'))).toBe('NOT_FOUND');
  });

  it('粘贴 JSON 批量导入：逐项落盘、重名覆盖', () => {
    saveMcpServer(stdio());
    const result = importMcpServers([
      stdio({ name: 'context7', args: ['overridden'] }),
      stdio({ name: 'playwright', command: 'npx' }),
    ]);

    expect(result.imported).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(listMcpServers()).toHaveLength(2);
    expect(listMcpServers().find((s) => s.name === 'context7')?.args).toEqual(['overridden']);
    expect(() => importMcpServers([])).toThrowError(/至少提供一个/);
  });

  it('粘贴原文导入：Claude / VS Code 等方言由服务端同一份解析器识别', () => {
    const claude = importMcpServersFromText(
      '{ "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }',
    );
    expect(claude.imported).toBe(1);
    expect(claude.style).toBe('mcpServers');
    expect(claude.servers[0]).toMatchObject({ name: 'context7', transport: 'http' });

    const vscode = importMcpServersFromText(
      JSON.stringify({
        servers: { playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
        inputs: [],
      }),
    );
    expect(vscode.imported).toBe(1);
    expect(vscode.style).toBe('servers');
    expect(vscode.servers.map((server) => server.name)).toEqual(['context7', 'playwright']);
  });

  it('粘贴原文导入：同名覆盖、clear 清空、混合结果返回 rejected', () => {
    saveMcpServer(stdio());
    const overwritten = importMcpServersFromText(
      JSON.stringify({ mcpServers: { context7: { url: 'https://new.invalid/mcp' } } }),
    );
    expect(overwritten.servers).toHaveLength(1);
    expect(overwritten.servers[0]).toMatchObject({ name: 'context7', transport: 'http', url: 'https://new.invalid/mcp' });

    const mixed = importMcpServersFromText(
      JSON.stringify({
        mcpServers: {
          good: { command: 'npx' },
          bad: { type: 'stdio' },
        },
      }),
      { clear: true },
    );
    expect(mixed.imported).toBe(1);
    expect(mixed.rejected.map((item) => item.name)).toEqual(['bad']);
    expect(listMcpServers().map((server) => server.name)).toEqual(['good']);
  });

  it('粘贴原文导入：认不出 / 全被拒时给中文 VALIDATION，不落盘', () => {
    expect(codeOf(() => importMcpServersFromText('{ "foo": 1 }'))).toBe('VALIDATION');
    expect(() => importMcpServersFromText('{ "mcpServers": { "x": { "type": "sdk" } } }')).toThrowError(/没有可导入/);
    expect(listMcpServers()).toEqual([]);
  });
});

describe('MCP 探针', () => {
  it('stdio：命令可执行即成功，找不到命令则失败', async () => {
    const ok = await probeMcpServer(stdio());
    expect(ok.state).toBe('ok');
    expect(ok.reason).toContain('可执行');
    expect(ok.checkedAt).toBeTruthy();

    const bad = await probeMcpServer(stdio({ command: 'aidocs-no-such-command-xyz' }));
    expect(bad.state).toBe('error');
    expect(bad.reason).toContain('找不到可执行命令');
  });

  it('http：initialize 探活成功', async () => {
    let seen: { method?: string; body?: string } = {};
    await withHttpServer(
      (req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          seen = { method: req.method, body: raw };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }));
        });
      },
      async (url) => {
        const result = await probeMcpServer({ ...stdio({ name: 'remote', transport: 'http' }), command: undefined, url });
        expect(result.state).toBe('ok');
        expect(result.reason).toContain('HTTP');
      },
    );
    expect(seen.method).toBe('POST');
    expect(JSON.parse(seen.body ?? '{}').method).toBe('initialize');
  });

  it('http：非 2xx 与连不上都返回失败原因', async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      },
      async (url) => {
        const result = await probeMcpServer({ ...stdio({ name: 'remote', transport: 'http' }), command: undefined, url });
        expect(result.state).toBe('error');
        expect(result.reason).toContain('401');
      },
    );

    const offline = await probeMcpServer({
      ...stdio({ name: 'offline', transport: 'http' }),
      command: undefined,
      url: 'http://127.0.0.1:1/mcp',
    });
    expect(offline.state).toBe('error');
    expect(offline.reason).toContain('无法连接');
  });
});
