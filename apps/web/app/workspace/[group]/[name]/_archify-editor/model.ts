export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`JSON 语法错误：${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('IR 必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}
