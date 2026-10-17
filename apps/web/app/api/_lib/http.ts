import { httpStatusOf, ServiceError } from '@aidocs/api';
import { ZodError, type ZodTypeAny, type output } from 'zod';

/** 统一 JSON 响应（不依赖 next/server，便于直接单测 route handler） */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** 服务层错误 → HTTP；zod 错误 → 400；未知错误 → 500。文案统一中文在前 */
export function errorResponse(error: unknown): Response {
  if (error instanceof ServiceError) {
    return json({ error: error.message, context: error.context ?? null }, httpStatusOf(error.code));
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}：` : '';
    return json({ error: `请求参数不合法：${where}${issue?.message ?? '格式错误'}` }, 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message || '内部错误' }, 500);
}

export interface RouteContext<P extends Record<string, string> = Record<string, string>> {
  params: Promise<P>;
}

/** 把 route handler 包一层错误映射；动态段的 params 类型显式传入 */
export function route<C = RouteContext>(
  handler: (request: Request, context: C) => Promise<Response | unknown> | Response | unknown,
): (request?: Request, context?: C) => Promise<Response> {
  return async (request?: Request, context?: C): Promise<Response> => {
    try {
      const result = await handler(request as Request, context as C);
      if (result instanceof Response) return result;
      return Response.json(result ?? null);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError('VALIDATION', '请求体不是合法 JSON');
  }
}

export async function readSchema<T extends ZodTypeAny>(request: Request, schema: T): Promise<output<T>> {
  return schema.parse(await readJsonBody(request));
}

/** DELETE 的 key：优先 query，其次 JSON body */
export async function readKey(request: Request, key: string): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get(key);
  if (fromQuery) return fromQuery;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const value = body?.[key];
  if (typeof value === 'string' && value) return value;
  throw new ServiceError('VALIDATION', `缺少参数：${key}`);
}


/* ---------- M3 路由用的便捷函数 ---------- */

export function readJson(request: Request): Promise<unknown> {
  return readJsonBody(request);
}

export function validate<S extends ZodTypeAny>(schema: S, input: unknown): output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}：` : '';
    throw new ServiceError('VALIDATION', `请求参数不合法：${where}${issue?.message ?? '格式错误'}`);
  }
  return parsed.data;
}
