import { findMcpLauncher, missingCommandHint, type McpProbeResult, type McpServer } from '@aidocs/contracts';
import { mcpSearchDirs, resolveMcpCommand, type ResolveCommandOptions } from './mcp-command';

/**
 * MCP 探针（简化版，不含 pi-mcp）：
 * - stdio：只检查命令是否可执行（不启动进程、不发 initialize）；
 * - http：对 URL 发一次 MCP `initialize`，拿到合法 JSON-RPC result 即成功。
 *
 * stdio 的「可执行」判定与真起进程用同一份解析（PATH + 常见安装目录），
 * 否则会出现探针绿了、会话里却起不来的假成功。
 * `options` 只给用例注入一份干净环境用，生产调用不传。
 */
export async function probeMcp(
  server: McpServer,
  options: ResolveCommandOptions = {},
): Promise<McpProbeResult> {
  if (server.transport === 'stdio') return probeStdio(server, options);
  return probeHttp(server);
}

function ok(reason: string, toolCount: number | null = null): McpProbeResult {
  return { state: 'ok', reason, toolCount, checkedAt: new Date().toISOString() };
}

function fail(reason: string): McpProbeResult {
  return { state: 'error', reason, toolCount: null, checkedAt: new Date().toISOString() };
}

function probeStdio(server: McpServer, options: ResolveCommandOptions): McpProbeResult {
  const command = (server.command ?? '').trim();
  if (!command) return fail('缺少 command');
  const resolved = resolveMcpCommand(command, options);
  if (!resolved) {
    const searched = options.extraDirs ?? mcpSearchDirs();
    return fail(missingCommandHint(command, searched));
  }
  const launcher = findMcpLauncher(command);
  if (launcher) {
    const tail = launcher.downloads ? '首次运行会现下载包，慢一点正常' : '模块需要已装在解释器的环境里';
    return ok(`命令可执行：${resolved}（${launcher.label}；探针只检查可执行性，${tail}）`);
  }
  return ok(`命令可执行：${resolved}（stdio 探针只检查可执行性，未启动 MCP 进程）`);
}

interface RpcPayload {
  result?: unknown;
  error?: { message?: string } | string;
}

async function probeHttp(server: McpServer): Promise<McpProbeResult> {
  const url = (server.url ?? '').trim();
  if (!url) return fail('缺少 url');
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '我的文档', version: '0.1.0' },
    },
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...server.headers,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return fail(`无法连接：${describeFetchError(error)}`);
  }
  if (!res.ok) return fail(`HTTP ${res.status}：${res.statusText || '请求被拒绝'}`);

  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    return fail(`读取响应失败：${describeFetchError(error)}`);
  }
  const payload = parseRpcPayload(text);
  if (!payload) return fail('响应不是合法的 JSON-RPC（可能是普通网页或代理错误页）');
  if (payload.error) {
    const message = typeof payload.error === 'string' ? payload.error : payload.error.message ?? JSON.stringify(payload.error);
    return fail(`服务端返回错误：${message}`);
  }
  if (payload.result === undefined) return fail('响应缺少 result 字段');

  const tools = (payload.result as { tools?: unknown }).tools;
  const toolCount = Array.isArray(tools) ? tools.length : null;
  return ok('HTTP 探活成功（initialize 响应正常）', toolCount);
}

function parseRpcPayload(text: string): RpcPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === 'object') return value as RpcPayload;
    } catch {
      /* 继续尝试下一种形态 */
    }
  }
  return null;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '连接超时（8 秒）';
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message}（${cause.message}）`;
    return error.message || String(error);
  }
  return String(error);
}
