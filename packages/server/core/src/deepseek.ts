import { z } from 'zod';

/**
 * DeepSeek「资料查询」客户端：Search + Fetch 两个原始 JSON API。
 * 官方文档：https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * - 鉴权与 Chat API 同一个 Bearer key；
 * - 只读、按成功次数计费、账号级各 5 QPS；
 * - 408/429/5xx 可重试，其它 4xx 不重试（本文档的明确要求）。
 */

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_LIMITS = {
  maxQuery: 128,
  maxCount: 50,
  maxUrl: 8192,
} as const;

export interface DeepseekOptions {
  baseUrl: string;
  apiKey: string;
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 可重试错误（408/429/5xx）的重试次数，默认 1 */
  retries?: number;
  retryDelayMs?: number;
  /** 调用方取消（聊天中止 / 工具 signal） */
  signal?: AbortSignal;
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  siteName: string | null;
  date: string | null;
  authority: number;
  rerankScore: number;
}

export interface DeepseekSearchInput {
  query: string;
  count?: number;
  needContent?: boolean;
  /** 用户原始问题，帮助搜索服务理解意图 */
  oriQuestion?: string;
}

export interface DeepseekFetchedPage {
  title: string;
  content: string;
}

export class DeepseekError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'DeepseekError';
    this.status = status;
    this.code = code;
  }
}

/* ---------------- 响应 schema ---------------- */

const SearchResultSchema = z.object({
  rerank_score: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  site_name: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  authority: z.number().optional(),
});

const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema).default([]) });

const FetchResponseSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
});

const ErrorResponseSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
});

/* ---------------- 地址与校验 ---------------- */

/** 拼出 `{base}/v1/tools/{search|fetch}`；base 已带 `/v1` 时不重复补 */
export function deepseekToolsUrl(baseUrl: string, tool: 'search' | 'fetch'): string {
  const base = (baseUrl.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const withV1 = /\/v1$/.test(base) ? base : `${base}/v1`;
  return `${withV1}/tools/${tool}`;
}

function assertQuery(query: string): void {
  const length = [...query].length;
  if (!query.trim()) throw new DeepseekError(400, '搜索词不能为空');
  if (length > DEEPSEEK_LIMITS.maxQuery) {
    throw new DeepseekError(400, `搜索词过长（${length} 字，上限 ${DEEPSEEK_LIMITS.maxQuery}）`);
  }
}

function assertUrl(url: string): void {
  if (url.length > DEEPSEEK_LIMITS.maxUrl) {
    throw new DeepseekError(400, `URL 过长（上限 ${DEEPSEEK_LIMITS.maxUrl} 字符）`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DeepseekError(400, `URL 不合法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DeepseekError(400, '只支持 http/https 地址');
  }
  if (parsed.username || parsed.password) {
    throw new DeepseekError(400, 'URL 不能携带用户名或密码');
  }
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > DEEPSEEK_LIMITS.maxCount) {
    throw new DeepseekError(400, `返回条数必须是 1–${DEEPSEEK_LIMITS.maxCount} 的整数`);
  }
}

/* ---------------- HTTP ---------------- */

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessageOf(raw: string): string {
  try {
    const parsed = ErrorResponseSchema.parse(JSON.parse(raw));
    return parsed.error?.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

async function postJson(url: string, body: unknown, options: DeepseekOptions, timeoutMs: number): Promise<unknown> {
  if (options.signal?.aborted) throw new DeepseekError(0, '请求已取消');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new DeepseekError(0, '请求已取消');
    throw error;
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new DeepseekError(response.status, errorMessageOf(text));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeepseekError(500, 'DeepSeek 返回的不是合法 JSON');
  }
}

async function postWithRetry(url: string, body: unknown, options: DeepseekOptions, timeoutMs: number): Promise<unknown> {
  const attempts = Math.max(0, options.retries ?? DEFAULT_RETRIES) + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await postJson(url, body, options, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof DeepseekError && RETRYABLE.has(error.status);
      if (!retryable || attempt === attempts - 1) throw error;
      await sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/* ---------------- 公开 API ---------------- */

/** 搜索：返回结构化结果；无匹配时是空数组（不算错误） */
export async function searchDeepseek(input: DeepseekSearchInput, options: DeepseekOptions): Promise<SearchHit[]> {
  assertQuery(input.query);
  const count = input.count ?? 10;
  assertCount(count);
  const payload: Record<string, unknown> = {
    query: input.query,
    count,
    need_content: input.needContent ?? false,
  };
  if (input.oriQuestion?.trim()) payload.ori_question = input.oriQuestion.trim();

  const json = await postWithRetry(deepseekToolsUrl(options.baseUrl, 'search'), payload, options, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const parsed = SearchResponseSchema.safeParse(json);
  if (!parsed.success) throw new DeepseekError(500, 'search.results 不符合预期', 'bad_schema');

  return parsed.data.results.map((hit) => ({
    title: hit.title ?? '',
    url: hit.url ?? '',
    snippet: hit.snippet ?? '',
    summary: hit.summary ?? '',
    content: hit.content ?? '',
    siteName: hit.site_name ?? null,
    date: hit.date ?? null,
    authority: hit.authority ?? -1,
    rerankScore: hit.rerank_score ?? 0,
  }));
}

/** 抓取单页：返回 Markdown 正文 */
export async function fetchDeepseek(url: string, options: DeepseekOptions): Promise<DeepseekFetchedPage> {
  assertUrl(url);
  const json = await postWithRetry(deepseekToolsUrl(options.baseUrl, 'fetch'), { url }, options, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const parsed = FetchResponseSchema.safeParse(json);
  if (!parsed.success) throw new DeepseekError(500, 'fetch 响应不符合预期', 'bad_schema');
  return { title: parsed.data.title ?? '', content: parsed.data.content ?? '' };
}

/** 把任意错误翻成一句中文原因（用户可读；vendor 原文放 error.message 里备查） */
export function deepseekReason(error: unknown): string {
  if (error instanceof DeepseekError) {
    if (error.code === 'bad_schema') return `DeepSeek 返回格式异常：${error.message}`;
    switch (error.status) {
      case 0:
        return '请求已取消';
      case 400:
        return `请求不合法：${error.message}`;
      case 401:
        return 'DeepSeek API Key 无效或缺失，请到设置页检查供应商';
      case 402:
        return 'DeepSeek 账户余额不足，请先充值';
      case 403:
        return '抓取被目标站点的安全策略拒绝';
      case 404:
        return '未能获取网页正文（URL 不可用、被站点拦截或没有可提取的正文）';
      case 408:
        return 'DeepSeek 读取超时，请重试';
      case 413:
        return '请求体超过大小限制';
      case 429:
        return '触发 DeepSeek 限流（Search/Fetch 各 5 QPS），请稍后重试';
      case 500:
      case 502:
      case 503:
      case 504:
        return 'DeepSeek 服务暂时不可用，请稍后重试';
      default:
        return `DeepSeek 返回 HTTP ${error.status}${error.message ? `：${error.message}` : ''}`;
    }
  }
  if (error instanceof z.ZodError) return 'DeepSeek 返回格式异常，无法解析';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时（DeepSeek 未在时限内返回）';
    if (error.name === 'AbortError') return '请求已取消';
    return `无法连接 DeepSeek：${error.message}`;
  }
  return String(error);
}
