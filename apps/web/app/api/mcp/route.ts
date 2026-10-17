import { z } from 'zod';
import { McpServerSchema } from '@aidocs/contracts';
import {
  deleteMcpServer,
  importMcpServers,
  importMcpServersFromText,
  listMcpServers,
  saveMcpServer,
} from '@aidocs/api';
import { json, readJsonBody, readKey, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

const ImportShape = z.object({
  servers: z.array(McpServerSchema).min(1, '至少提供一个 MCP 配置'),
  clear: z.boolean().optional(),
});
const TextImportShape = z.object({
  text: z.string().min(1, '贴入内容不能为空'),
  clear: z.boolean().optional(),
});
const ListShape = z.array(McpServerSchema).min(1, '至少提供一个 MCP 配置');

export const GET = route(async () => json(listMcpServers()));

export const POST = route(async (request) => {
  const raw = await readJsonBody(request);
  if (Array.isArray(raw)) return json(importMcpServers(ListShape.parse(raw)), 201);
  const object = z.record(z.unknown()).parse(raw);
  if (typeof object.text === 'string') {
    const input = TextImportShape.parse(object);
    return json(importMcpServersFromText(input.text, { clear: input.clear }), 201);
  }
  if (Array.isArray(object.servers)) {
    const input = ImportShape.parse(object);
    return json(importMcpServers(input.servers, { clear: input.clear }), 201);
  }
  return json(saveMcpServer(McpServerSchema.parse(raw)), 201);
});

export const DELETE = route(async (request) => {
  deleteMcpServer(await readKey(request, 'name'));
  return json({ ok: true });
});
