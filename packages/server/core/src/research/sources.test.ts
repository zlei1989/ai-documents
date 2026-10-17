import { describe, expect, it } from 'vitest';
import { eurostatSource, worldBankSource } from './sources/data';
import {
  arxivSource,
  crossrefSource,
  doajSource,
  europePmcSource,
  openAlexAbstract,
  openAlexSource,
  parseAtomEntries,
  pubmedSource,
} from './sources/academic';
import { gutenbergSource } from './sources/books';
import { clinicalTrialsSource, gbifSource } from './sources/life';
import { webSource } from './sources/web';
import type { SourceContext } from './types';

interface Stub {
  calls: string[];
  inits: RequestInit[];
  fetchImpl: typeof fetch;
}

function stubFetch(handler: (url: string) => unknown): Stub {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init) inits.push(init);
    const result = handler(url);
    if (result instanceof Response) return result;
    return new Response(typeof result === 'string' ? result : JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, inits, fetchImpl };
}

function ctxOf(stub: Stub): SourceContext {
  return { fetchImpl: stub.fetchImpl };
}

describe('Crossref', () => {
  it('发起书目查询并映射 DOI / 标题 / 期刊 / 年份', async () => {
    const stub = stubFetch(() => ({
      message: {
        'total-results': 1234,
        items: [
          {
            DOI: '10.1/ABC',
            title: ['Edge architecture'],
            author: [
              { given: 'Ada', family: 'Lovelace' },
              { given: 'Alan', family: 'Turing' },
            ],
            published: { 'date-parts': [[2024, 3, 2]] },
            'container-title': ['Journal of Tests'],
            URL: 'https://doi.org/10.1/ABC',
          },
        ],
      },
    }));

    const output = await crossrefSource.search({ query: 'edge', limit: 5 }, ctxOf(stub));

    expect(stub.calls[0]).toContain('query.bibliographic=edge');
    expect(stub.calls[0]).toContain('rows=5');
    expect(output.note).toContain('1,234');
    expect(output.hits[0]).toMatchObject({
      title: 'Edge architecture',
      url: 'https://doi.org/10.1/ABC',
      dedupeKey: '10.1/abc',
    });
    expect(output.hits[0]!.meta).toContain('Journal of Tests');
    expect(output.hits[0]!.meta).toContain('2024');
    expect(output.hits[0]!.meta).toContain('Ada Lovelace');
  });
});

describe('OpenAlex', () => {
  it('把倒排索引拼回摘要，并带引用数', async () => {
    expect(openAlexAbstract({ Hello: [0], world: [1], again: [2] })).toBe('Hello world again');
    const stub = stubFetch(() => ({
      meta: { count: 7 },
      results: [
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.1/XYZ',
          title: 'Octopus brains',
          publication_year: 2023,
          authorships: [{ author: { display_name: 'Jane Doe' } }],
          abstract_inverted_index: { Octopus: [0], intelligence: [1] },
          primary_location: { source: { display_name: 'Nature' } },
          cited_by_count: 42,
        },
      ],
    }));

    const output = await openAlexSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(output.hits[0]).toMatchObject({
      title: 'Octopus brains',
      url: 'https://doi.org/10.1/XYZ',
      snippet: 'Octopus intelligence',
      dedupeKey: '10.1/xyz',
    });
    expect(output.hits[0]!.meta).toContain('引用 42');
    expect(output.note).toContain('7');
  });
});

describe('Europe PMC', () => {
  it('JSON 结果带摘要与 DOI', async () => {
    const stub = stubFetch(() => ({
      hitCount: 15032,
      resultList: {
        result: [
          {
            doi: '10.1/epmc',
            title: 'Octopus study',
            abstractText: 'A long abstract about octopus.',
            journalTitle: 'J Exp Biol',
            pubYear: '2022',
            authorString: 'A, B',
          },
        ],
      },
    }));
    const output = await europePmcSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(stub.calls[0]).toContain('resultType=core');
    expect(output.hits[0]!.url).toBe('https://doi.org/10.1/epmc');
    expect(output.hits[0]!.snippet).toContain('long abstract');
    expect(output.hits[0]!.meta).toContain('J Exp Biol');
  });
});

describe('PubMed', () => {
  it('先 esearch 再 esummary，映射 PMID 链接', async () => {
    const stub = stubFetch((url) =>
      url.includes('esearch')
        ? { esearchresult: { count: '3935', idlist: ['111', '222'] } }
        : {
            result: {
              uids: ['111', '222'],
              '111': { title: 'Paper one', source: 'Nature', pubdate: '2023', authors: [{ name: 'Doe J' }] },
              '222': { title: 'Paper two', source: 'Science', pubdate: '2024', authors: [{ name: 'Roe R' }] },
            },
          },
    );
    const output = await pubmedSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(stub.calls).toHaveLength(2);
    expect(output.note).toContain('3,935');
    expect(output.hits[0]).toMatchObject({
      title: 'Paper one',
      url: 'https://pubmed.ncbi.nlm.nih.gov/111/',
      dedupeKey: 'pmid:111',
    });
  });

  it('没有命中时不发第二次请求', async () => {
    const stub = stubFetch(() => ({ esearchresult: { count: '0', idlist: [] } }));
    const output = await pubmedSource.search({ query: 'none', limit: 5 }, ctxOf(stub));
    expect(output.hits).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('DOAJ', () => {
  it('映射摘要、期刊与全文链接', async () => {
    const stub = stubFetch(() => ({
      total: 10,
      results: [
        {
          bibjson: {
            title: 'OA paper',
            abstract: 'Open access abstract.',
            year: '2021',
            journal: { title: 'PLoS ONE' },
            author: [{ name: 'Author A' }],
            link: [{ url: 'https://fulltext', type: 'fulltext' }],
            identifier: [{ id: '10.1/doaj', type: 'doi' }],
          },
        },
      ],
    }));
    const output = await doajSource.search({ query: 'oa', limit: 5 }, ctxOf(stub));
    expect(output.hits[0]).toMatchObject({ title: 'OA paper', url: 'https://fulltext', dedupeKey: '10.1/doaj' });
    expect(output.hits[0]!.snippet).toContain('Open access');
    expect(output.note).toContain('10');
  });
});

describe('arXiv', () => {
  it('解析 Atom 条目', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed><entry>
        <id>http://arxiv.org/abs/2401.00001v1</id>
        <published>2024-01-01T00:00:00Z</published>
        <title>  A  study of &amp; octopus </title>
        <summary>We study octopus.</summary>
        <author><name>Alice</name></author>
        <author><name>Bob</name></author>
      </entry></feed>`;
    expect(parseAtomEntries(xml)).toHaveLength(1);
    const stub = stubFetch(() => new Response(xml, { status: 200, headers: { 'content-type': 'application/atom+xml' } }));
    const output = await arxivSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(stub.calls[0]).toContain('export.arxiv.org/api/query');
    expect(output.hits[0]).toMatchObject({ title: 'A study of & octopus', url: 'http://arxiv.org/abs/2401.00001v1' });
    expect(output.hits[0]!.meta).toContain('Alice');
  });
});

describe('Project Gutenberg', () => {
  it('返回书名、作者与全文链接', async () => {
    const stub = stubFetch(() => ({
      count: 7,
      results: [
        {
          id: 11,
          title: 'Alice',
          authors: [{ name: 'Carroll, Lewis' }],
          subjects: ['Fantasy'],
          download_count: 100,
          formats: { 'text/plain; charset=utf-8': 'https://gutenberg.org/files/11/11-0.txt' },
        },
      ],
    }));
    const output = await gutenbergSource.search({ query: 'alice', limit: 5 }, ctxOf(stub));
    expect(output.hits[0]).toMatchObject({
      title: 'Alice',
      url: 'https://www.gutenberg.org/ebooks/11',
      fullTextUrl: 'https://gutenberg.org/files/11/11-0.txt',
    });
    expect(output.note).toContain('7');
  });
});

describe('GBIF', () => {
  it('映射学名、分类与物种页链接', async () => {
    const stub = stubFetch(() => ({
      count: 3495,
      results: [
        {
          key: 141305527,
          scientificName: 'Octopus',
          rank: 'GENUS',
          taxonomicStatus: 'ACCEPTED',
          kingdom: 'Animalia',
          phylum: 'Mollusca',
        },
      ],
    }));
    const output = await gbifSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(output.hits[0]).toMatchObject({ title: 'Octopus', url: 'https://www.gbif.org/species/141305527' });
    expect(output.hits[0]!.snippet).toContain('Animalia > Mollusca');
  });
});

describe('ClinicalTrials.gov', () => {
  it('只取必要字段，拼出状态/分期/申办方', async () => {
    const stub = stubFetch(() => ({
      studies: [
        {
          protocolSection: {
            identificationModule: { nctId: 'NCT03333954', briefTitle: 'Feasibility study' },
            statusModule: { overallStatus: 'COMPLETED', startDateStruct: { date: '2017-11-06' } },
            sponsorCollaboratorsModule: { leadSponsor: { name: 'Science Corp' } },
            descriptionModule: { briefSummary: 'A brief summary.' },
            designModule: { phases: ['PHASE2'] },
            conditionsModule: { conditions: ['AMD'] },
          },
        },
      ],
    }));
    const output = await clinicalTrialsSource.search({ query: 'octopus', limit: 5 }, ctxOf(stub));
    expect(stub.calls[0]).toContain('fields=NCTId');
    expect(output.hits[0]).toMatchObject({ title: 'Feasibility study', url: 'https://clinicaltrials.gov/study/NCT03333954' });
    expect(output.hits[0]!.meta).toContain('COMPLETED');
    expect(output.hits[0]!.meta).toContain('PHASE2');
    expect(output.hits[0]!.meta).toContain('Science Corp');
  });
});

describe('World Bank', () => {
  it('映射文档标题、摘要与文档链接', async () => {
    const stub = stubFetch(() => ({
      total: 127548,
      documents: {
        D1: {
          id: 'D1',
          display_title: 'Climate finance',
          abstracts: { 'cdata!': 'Background paper on climate finance.' },
          docdt: '2016-06-01T00:00:00Z',
          docty: 'Working Paper',
          lang: 'English',
          url: 'https://documents.worldbank.org/1',
        },
      },
    }));
    const output = await worldBankSource.search({ query: 'climate', limit: 5 }, ctxOf(stub));
    expect(output.hits[0]).toMatchObject({ title: 'Climate finance', url: 'https://documents.worldbank.org/1' });
    expect(output.hits[0]!.snippet).toContain('Background paper');
    expect(output.hits[0]!.meta).toContain('Working Paper');
    expect(output.note).toContain('127,548');
  });
});

describe('Eurostat', () => {
  it('内置目录按英文/中文关键词匹配，不需要网络', async () => {
    const stub = stubFetch(() => {
      throw new Error('Eurostat 目录不应该发网络请求');
    });
    const gdp = await eurostatSource.search({ query: 'gdp', limit: 5 }, ctxOf(stub));
    const chinese = await eurostatSource.search({ query: '人口', limit: 5 }, ctxOf(stub));
    const inflation = await eurostatSource.search({ query: '通胀', limit: 3 }, ctxOf(stub));

    expect(gdp.hits[0]).toMatchObject({ title: expect.stringContaining('Gross domestic product') });
    expect(gdp.hits[0]!.url).toContain('nama_10_gdp');
    expect(chinese.hits.length).toBeGreaterThan(0);
    expect(chinese.hits[0]!.title.toLowerCase()).toContain('population');
    expect(inflation.hits[0]!.url).toContain('prc_hicp');
    expect(gdp.note).toContain('内置');
  });
});

describe('web（DeepSeek 联网）', () => {
  it('映射标题/摘要/站点，并按 limit 放大条数', async () => {
    const stub = stubFetch(() => ({
      results: [
        {
          title: 'DeepSeek V4',
          url: 'https://example.com/a',
          summary: 'Summary text',
          site_name: 'Example',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        },
      ],
    }));
    const output = await webSource.search(
      { query: 'DeepSeek', limit: 5 },
      { fetchImpl: stub.fetchImpl, deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' } },
    );
    expect(stub.calls[0]).toContain('/v1/tools/search');
    const body = JSON.parse(String(stub.inits[0]!.body)) as { count: number; query: string };
    expect(body).toMatchObject({ query: 'DeepSeek', count: 10 });
    expect(output.hits[0]).toMatchObject({ title: 'DeepSeek V4', url: 'https://example.com/a' });
    expect(output.hits[0]!.meta).toContain('Example');
    expect(output.hits[0]!.meta).toContain('权威 3/4');
  });

  it('缺少 DeepSeek 凭据时报错', async () => {
    await expect(webSource.search({ query: 'x', limit: 5 }, {})).rejects.toThrow('未配置');
  });
});
