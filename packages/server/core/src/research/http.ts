import { DeepseekError, deepseekReason } from '../deepseek';
import type { SourceContext } from './types';

/** 数据源 HTTP 错误：status 保留原始状态码，message 是 vendor 原文（截断） */
export class SourceHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SourceHttpError';
    this.status = status;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineSignals(ctx: SourceContext, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!ctx.signal) return { signal: timeout, cleanup: () => undefined };
  return { signal: AbortSignal.any([timeout, ctx.signal]), cleanup: () => undefined };
}

async function request(url: string, ctx: SourceContext, timeoutMs: number, accept: string, init?: RequestInit): Promise<Response> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const { signal } = combineSignals(ctx, timeoutMs);
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept, ...(init?.headers as Record<string, string> | undefined) },
    signal,
  });
  return response;
}

async function readBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // 响应头到了、body 读一半被超时/断流：不能当空内容处理
    throw new SourceHttpError(0, `读取响应体失败：${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new SourceHttpError(response.status, text.slice(0, 300));
  }
  return text;
}

/** 带一次重试的文本 GET（408/429/5xx 重试；其它 4xx 直接抛） */
export async function getText(url: string, ctx: SourceContext, init?: RequestInit): Promise<string> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(url, ctx, timeoutMs, 'text/plain, application/json, application/xml, */*', init);
      return await readBody(response);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof SourceHttpError && RETRYABLE.has(error.status);
      if (!retryable || attempt === 1 || ctx.signal?.aborted) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** 带一次重试的 JSON GET */
export async function getJson(url: string, ctx: SourceContext, init?: RequestInit): Promise<unknown> {
  const text = await getText(url, ctx, init);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceHttpError(500, '返回的不是合法 JSON');
  }
}

/** 把数据源错误翻成中文原因 */
export function sourceErrorReason(error: unknown): string {
  if (error instanceof DeepseekError) return deepseekReason(error);
  if (error instanceof SourceHttpError) {
    if (error.status === 401 || error.status === 403) return '接口拒绝访问（可能需要 API Key 或超出额度）';
    if (error.status === 404) return '接口没有找到对应内容';
    if (error.status === 429) return '请求过于频繁（限流），请稍后重试';
    if (error.status >= 500) return `数据源服务异常（HTTP ${error.status}）`;
    return `请求失败（HTTP ${error.status}）${error.message ? `：${error.message}` : ''}`;
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时';
    if (error.name === 'AbortError') return '请求已取消';
    return `无法连接数据源：${error.message}`;
  }
  return String(error);
}

/** 把 HTML 实体与多余空白收拾干净（Atom/JSON 里常见） */
export function cleanText(input: string | undefined | null): string {
  if (!input) return '';
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function encodeQuery(value: string): string {
  return encodeURIComponent(value.trim());
}
