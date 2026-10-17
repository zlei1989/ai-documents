import { describe, expect, it } from 'vitest';
import {
  DeepseekError,
  deepseekReason,
  deepseekToolsUrl,
  fetchDeepseek,
  searchDeepseek,
  type DeepseekOptions,
} from './deepseek';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('没有预置的响应了');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function options(overrides: Partial<DeepseekOptions> = {}): DeepseekOptions {
  return { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', retries: 0, retryDelayMs: 0, ...overrides };
}

describe('deepseekToolsUrl', () => {
  it('补 /v1，且不重复补', () => {
    expect(deepseekToolsUrl('https://api.deepseek.com', 'search')).toBe('https://api.deepseek.com/v1/tools/search');
    expect(deepseekToolsUrl('https://api.deepseek.com/', 'fetch')).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(deepseekToolsUrl('https://api.deepseek.com/v1', 'search')).toBe('https://api.deepseek.com/v1/tools/search');
    expect(deepseekToolsUrl('  ', 'search')).toBe('https://api.deepseek.com/v1/tools/search');
  });
});

describe('searchDeepseek', () => {
  it('按官方协议发请求，并把结果字段映射成 camelCase', async () => {
    const { calls, fetchImpl } = stubFetch([
      jsonResponse({
        results: [
          {
            rerank_score: 2.4,
            title: 'DeepSeek V4 模型发布',
            url: 'https://example.com/a',
            snippet: '短摘要',
            summary: '长摘要',
            content: '',
            site_name: 'Example News',
            site_icon: null,
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
          },
        ],
      }),
    ]);

    const hits = await searchDeepseek({ query: 'DeepSeek V4', count: 5, needContent: false }, options({ fetchImpl }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: 'DeepSeek V4', count: 5, need_content: false });
    expect(hits).toEqual([
      {
        title: 'DeepSeek V4 模型发布',
        url: 'https://example.com/a',
        snippet: '短摘要',
        summary: '长摘要',
        content: '',
        siteName: 'Example News',
        date: '2026-06-01T00:00:00+00:00',
        authority: 3,
        rerankScore: 2.4,
      },
    ]);
  });

  it('oriQuestion 映射成 ori_question；无结果返回空数组', async () => {
    const { calls, fetchImpl } = stubFetch([jsonResponse({ results: [] })]);
    const hits = await searchDeepseek({ query: '网关', oriQuestion: '网关怎么设计' }, options({ fetchImpl }));
    expect(hits).toEqual([]);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ ori_question: '网关怎么设计', count: 10 });
  });

  it('搜索词为空或超长时本地拒绝，不发请求', async () => {
    const { calls, fetchImpl } = stubFetch([]);
    await expect(searchDeepseek({ query: '   ' }, options({ fetchImpl }))).rejects.toThrow('搜索词不能为空');
    await expect(searchDeepseek({ query: 'x'.repeat(129) }, options({ fetchImpl }))).rejects.toThrow('搜索词过长');
    expect(calls).toHaveLength(0);
  });

  it('条数越界本地拒绝', async () => {
    const { fetchImpl } = stubFetch([]);
    await expect(searchDeepseek({ query: 'x', count: 51 }, options({ fetchImpl }))).rejects.toThrow('1–50');
    await expect(searchDeepseek({ query: 'x', count: 0 }, options({ fetchImpl }))).rejects.toThrow('1–50');
  });

  it('401 给中文原因，且不重试', async () => {
    const { calls, fetchImpl } = stubFetch([
      jsonResponse({ error: { message: 'invalid key', code: 'invalid_api_key' } }, 401),
    ]);
    const error = await searchDeepseek({ query: 'x' }, options({ fetchImpl, retries: 3 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeepseekError);
    expect(deepseekReason(error)).toContain('API Key 无效');
    expect(calls).toHaveLength(1);
  });

  it('429 会重试一次后成功', async () => {
    const { calls, fetchImpl } = stubFetch([
      jsonResponse({ error: { message: 'qps' } }, 429),
      jsonResponse({ results: [{ title: 'ok', url: 'https://example.com' }] }),
    ]);
    const hits = await searchDeepseek({ query: 'x' }, options({ fetchImpl, retries: 1 }));
    expect(hits).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('429 重试后仍失败 → 限流文案', async () => {
    const { calls, fetchImpl } = stubFetch([
      jsonResponse({ error: { message: 'qps' } }, 429),
      jsonResponse({ error: { message: 'qps' } }, 429),
    ]);
    const error = await searchDeepseek({ query: 'x' }, options({ fetchImpl, retries: 1 })).catch((e: unknown) => e);
    expect(deepseekReason(error)).toContain('限流');
    expect(calls).toHaveLength(2);
  });

  it('返回结构不符时报格式异常', async () => {
    const { fetchImpl } = stubFetch([jsonResponse({ results: 'nope' })]);
    const error = await searchDeepseek({ query: 'x' }, options({ fetchImpl })).catch((e: unknown) => e);
    expect(deepseekReason(error)).toContain('格式异常');
  });

  it('已取消的 signal 直接拒绝且不发请求', async () => {
    const { calls, fetchImpl } = stubFetch([]);
    const controller = new AbortController();
    controller.abort();
    const error = await searchDeepseek({ query: 'x' }, options({ fetchImpl, signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect(deepseekReason(error)).toBe('请求已取消');
    expect(calls).toHaveLength(0);
  });
});

describe('fetchDeepseek', () => {
  it('发 url 并返回 Markdown 正文', async () => {
    const { calls, fetchImpl } = stubFetch([jsonResponse({ title: 'Example article', content: '# Example\n\n正文' })]);
    const page = await fetchDeepseek('https://example.com/a', options({ fetchImpl }));
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: 'https://example.com/a' });
    expect(page).toEqual({ title: 'Example article', content: '# Example\n\n正文' });
  });

  it('非法 URL 本地拒绝', async () => {
    const { calls, fetchImpl } = stubFetch([]);
    await expect(fetchDeepseek('not-a-url', options({ fetchImpl }))).rejects.toThrow('URL 不合法');
    await expect(fetchDeepseek('ftp://example.com', options({ fetchImpl }))).rejects.toThrow('http/https');
    await expect(fetchDeepseek('https://user:pass@example.com', options({ fetchImpl }))).rejects.toThrow('用户名或密码');
    expect(calls).toHaveLength(0);
  });

  it('404 给「未能获取网页正文」', async () => {
    const { fetchImpl } = stubFetch([jsonResponse({ error: { message: 'no content' } }, 404)]);
    const error = await fetchDeepseek('https://example.com/a', options({ fetchImpl })).catch((e: unknown) => e);
    expect(deepseekReason(error)).toContain('未能获取网页正文');
  });
});

describe('deepseekReason', () => {
  it('把网络错误与超时翻成中文', () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(deepseekReason(timeout)).toContain('请求超时');
    expect(deepseekReason(new Error('ECONNREFUSED'))).toBe('无法连接 DeepSeek：ECONNREFUSED');
    expect(deepseekReason(402)).toBe(String(402));
  });
});
