import { describe, expect, it } from 'vitest';
import { dedupeSourceResults, normalizeSourceIds, searchSources, researchSourceInfos } from './registry';
import type { SourceResult } from './types';

function result(source: string, label: string, urls: string[]): SourceResult {
  return {
    source,
    label,
    elapsedMs: 1,
    hits: urls.map((url) => ({ title: url, url })),
  };
}

describe('normalizeSourceIds', () => {
  it('web 永远排第一并强制带上', () => {
    expect(normalizeSourceIds(['crossref'])).toEqual(['web', 'crossref']);
    expect(normalizeSourceIds([])).toEqual(['web']);
    expect(normalizeSourceIds(['crossref', 'web'])).toEqual(['web', 'crossref']);
  });

  it('停用的源会被过滤，但停用 web 无效', () => {
    expect(normalizeSourceIds(['crossref', 'doaj'], ['doaj'])).toEqual(['web', 'crossref']);
    expect(normalizeSourceIds([], ['web'])).toEqual(['web']);
  });

  it('未知 id 被丢掉', () => {
    expect(normalizeSourceIds(['nope', 'crossref'])).toEqual(['web', 'crossref']);
  });
});

describe('dedupeSourceResults', () => {
  it('同一个 URL/DOI 只保留第一个源的那条', () => {
    const merged = dedupeSourceResults([
      result('crossref', 'Crossref', ['https://doi.org/10.1/a', 'https://doi.org/10.1/b']),
      result('openalex', 'OpenAlex', ['https://doi.org/10.1/A', 'https://doi.org/10.1/c']),
    ]);
    expect(merged[0]!.hits).toHaveLength(2);
    expect(merged[1]!.hits.map((hit) => hit.url)).toEqual(['https://doi.org/10.1/c']);
  });

  it('优先用 dedupeKey 去重', () => {
    const merged = dedupeSourceResults([
      { ...result('a', 'A', ['https://x/1']), hits: [{ title: 't', url: 'https://x/1', dedupeKey: 'doi:1' }] },
      { ...result('b', 'B', ['https://y/2']), hits: [{ title: 't', url: 'https://y/2', dedupeKey: 'doi:1' }, { title: 'u', url: 'https://y/3' }] },
    ]);
    expect(merged[1]!.hits.map((hit) => hit.url)).toEqual(['https://y/3']);
  });
});

describe('searchSources', () => {
  it('并发执行、单源失败不影响其它源', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('crossref.org')) return new Response('boom', { status: 500 });
      if (url.includes('deepseek.com')) {
        return new Response(JSON.stringify({ results: [{ title: 'web hit', url: 'https://example.com/web' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ total: 2, results: [{ bibjson: { title: 'oa hit', link: [{ url: 'https://example.com/oa' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const results = await searchSources(['web', 'crossref', 'doaj'], { query: 'x', limit: 5 }, {
      fetchImpl,
      deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' },
    });

    expect(results.map((item) => item.source)).toEqual(['web', 'crossref', 'doaj']);
    expect(results[0]!.hits[0]!.title).toBe('web hit');
    expect(results[1]!.error).toContain('数据源服务异常');
    expect(results[2]!.hits[0]!.title).toBe('oa hit');
  });
});

describe('researchSourceInfos', () => {
  it('web 标记为必查，其余不带 always', () => {
    const infos = researchSourceInfos();
    expect(infos.find((info) => info.id === 'web')).toMatchObject({ always: true, needsKey: false });
    expect(infos.filter((info) => info.always)).toHaveLength(1);
    expect(infos.length).toBeGreaterThanOrEqual(10);
  });
});
