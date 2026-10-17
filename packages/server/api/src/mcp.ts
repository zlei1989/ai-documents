import {
  McpServerSchema,
  parseMcpImport,
  type McpImportRejection,
  type McpImportStyle,
  type McpProbeResult,
  type McpServer,
} from '@aidocs/contracts';
import { probeMcp, readConfig, updateConfig } from '@aidocs/core';
import { ServiceError } from './service-error';

/** 导入选项：`clear` 是用户明确勾选的「先清空现有条目再导入」 */
export interface McpImportOptions {
  clear?: boolean;
}

/** 导入结果：`rejected` 是这份文本里逐条认不出的配置（其余照常导入） */
export interface McpImportSummary {
  imported: number;
  servers: McpServer[];
  rejected: McpImportRejection[];
  style?: McpImportStyle;
}

function normalize(input: McpServer): McpServer {
  let parsed: McpServer;
  try {
    parsed = McpServerSchema.parse(input);
  } catch (error) {
    throw new ServiceError('VALIDATION', `MCP 配置不合法：${(error as Error).message}`);
  }
  const name = parsed.name.trim();
  if (!name) throw new ServiceError('VALIDATION', '名称不能为空');
  if (parsed.transport === 'stdio' && !parsed.command?.trim()) {
    throw new ServiceError('VALIDATION', 'stdio 传输必须填写 command');
  }
  if (parsed.transport === 'http' && !parsed.url?.trim()) {
    throw new ServiceError('VALIDATION', 'http 传输必须填写 url');
  }
  return { ...parsed, name, command: parsed.command?.trim(), url: parsed.url?.trim() };
}

function upsert(servers: McpServer[], server: McpServer): void {
  const idx = servers.findIndex((s) => s.name === server.name);
  if (idx >= 0) servers[idx] = server;
  else servers.push(server);
}

export function listMcpServers(): McpServer[] {
  return readConfig().mcpServers;
}

export function saveMcpServer(input: McpServer): McpServer {
  const server = normalize(input);
  let saved: McpServer | undefined;
  updateConfig((config) => {
    upsert(config.mcpServers, server);
    saved = server;
  });
  if (!saved) throw new ServiceError('INTERNAL', '保存 MCP 配置失败');
  return saved;
}

export function deleteMcpServer(name: string): void {
  updateConfig((config) => {
    const idx = config.mcpServers.findIndex((s) => s.name === name);
    if (idx < 0) throw new ServiceError('NOT_FOUND', `MCP 配置不存在：${name}`);
    config.mcpServers.splice(idx, 1);
  });
}

/** 粘贴 JSON 导入：接受已归一的数组，逐项校验后按 name 覆盖写入 */
export function importMcpServers(items: McpServer[], options: McpImportOptions = {}): McpImportSummary {
  if (items.length === 0) throw new ServiceError('VALIDATION', '至少提供一个 MCP 配置');
  const normalized = items.map((item, index) => {
    try {
      return normalize(item);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw new ServiceError(error.code, `第 ${index + 1} 项：${error.message}`);
      }
      throw error;
    }
  });
  return persistImport(normalized, [], options);
}

/**
 * 粘贴 JSON 导入（原文）：服务端用与设置页预览**同一份**解析器识别多种方言，
 * 这样即使调用方直接打 API，也不必先自己把配置翻译成本应用的数组形状。
 */
export function importMcpServersFromText(text: string, options: McpImportOptions = {}): McpImportSummary {
  const parsed = parseMcpImport(text, listMcpServers());
  if (parsed.error !== undefined) throw new ServiceError('VALIDATION', parsed.error.message);
  if (parsed.entries.length === 0) {
    const reasons = parsed.rejected
      .slice(0, 5)
      .map((item) => `${item.name}：${item.reason}`)
      .join('；');
    throw new ServiceError(
      'VALIDATION',
      reasons === '' ? '没有可导入的 MCP 配置' : `没有可导入的 MCP 配置：${reasons}`,
    );
  }

  const normalized = parsed.entries.map((entry) => {
    try {
      return normalize(entry.server);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw new ServiceError(error.code, `「${entry.name}」：${error.message}`);
      }
      throw error;
    }
  });
  return persistImport(normalized, parsed.rejected, options, parsed.style);
}

function persistImport(
  servers: McpServer[],
  rejected: McpImportRejection[],
  options: McpImportOptions,
  style?: McpImportStyle,
): McpImportSummary {
  let saved: McpServer[] = [];
  updateConfig((config) => {
    if (options.clear === true) config.mcpServers = [];
    for (const server of servers) upsert(config.mcpServers, server);
    saved = config.mcpServers;
  });
  return {
    imported: servers.length,
    servers: saved,
    rejected,
    ...(style === undefined ? {} : { style }),
  };
}

export async function probeMcpServer(server: McpServer): Promise<McpProbeResult> {
  return probeMcp(normalize(server));
}

export async function probeSavedMcpServer(name: string): Promise<McpProbeResult> {
  const server = readConfig().mcpServers.find((s) => s.name === name);
  if (!server) throw new ServiceError('NOT_FOUND', `MCP 配置不存在：${name}`);
  return probeMcp(server);
}
