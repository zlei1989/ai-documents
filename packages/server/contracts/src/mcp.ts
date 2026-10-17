import { z } from 'zod';

/**
 * MCP 服务器契约（canonical 形状）。
 *
 * 形状是**扁平的一条一条**（名字住在条目里），而不是参考仓库那种 name-keyed map：
 *   · 类型勾选、列表渲染、探针都按「条目」消费，数组比 map 少一层键值转换；
 *   · 粘贴导入的多种方言（mcpServers / servers / 单台…）在解析层统一收敛到这里，
 *     落盘与注入只认这一种形状。
 *
 * 只放**纯形状**：没有 IO、没有默认条目。解析与多格式识别在 `mcp-import.ts`。
 */
export const McpTransportSchema = z.enum(['stdio', 'http'], {
  errorMap: () => ({ message: '传输只支持 stdio 或 http' }),
});
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  transport: McpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  url: z.string().optional(),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type McpServer = z.infer<typeof McpServerSchema>;
