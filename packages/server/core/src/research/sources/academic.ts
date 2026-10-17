import { cleanText, encodeQuery, getJson, getText, truncate } from '../http';
import type { ResearchSource, SourceContext, SourceHit, SourceSearchOutput } from '../types';

/* ------------------------------------------------------------------ */
/* 公共小工具                                                          */
/* ------------------------------------------------------------------ */

function authorsText(names: (string | undefined | null)[], max = 3): string {
  const list = names.map((name) => cleanText(name ?? '')).filter(Boolean);
  if (list.length === 0) return '';
  const head = list.slice(0, max).join(', ');
  return list.length > max ? `${head} 等` : head;
}

function joinMeta(parts: (string | number | undefined | null)[]): string {
  return parts
    .map((part) => (typeof part === 'number' ? String(part) : cleanText(part ?? '')))
    .filter(Boolean)
    .join(' · ');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitOf(input: { limit: number }): number {
  return Math.min(10, Math.max(1, input.limit));
}

/* ------------------------------------------------------------------ */
/* Crossref：论文 / DOI / 期刊元数据                                    */
/* ------------------------------------------------------------------ */

export const crossrefSource: ResearchSource = {
  id: 'crossref',
  label: 'Crossref 论文元数据',
  routing: '论文/期刊/会议/图书的 DOI、作者、期刊、出版年、引用数；查「某篇论文」或「某主题有哪些论文」首选',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const rows = limitOf(input);
    const params = [
      `query.bibliographic=${encodeQuery(input.query)}`,
      `rows=${rows}`,
      'select=DOI,title,author,published,container-title,URL,type',
      ...(input.yearFrom ? [`filter=from-pub-date:${input.yearFrom}-01-01`] : []),
    ];
    const json = asRecord(await getJson(`https://api.crossref.org/works?${params.join('&')}`, ctx));
    const message = asRecord(json.message);
    const items = asArray(message.items);
    const total = asNumber(message['total-results']);
    const hits: SourceHit[] = items.map((raw) => {
      const item = asRecord(raw);
      const doi = asString(item.DOI);
      const title = cleanText(Array.isArray(item.title) ? asString(item.title[0]) : asString(item.title)) || '（无标题）';
      const names = asArray(item.author).map((author) => {
        const record = asRecord(author);
        return `${asString(record.given)} ${asString(record.family)}`.trim();
      });
      const published = asRecord(item.published);
      const year = asNumber(asArray(asArray(published['date-parts'])[0])[0]);
      const container = cleanText(asArray(item['container-title']).map(asString)[0] ?? '');
      const meta = joinMeta([container, year, authorsText(names)]);
      return {
        title,
        url: asString(item.URL) || (doi ? `https://doi.org/${doi}` : ''),
        ...(meta ? { meta } : {}),
        ...(doi ? { dedupeKey: doi.toLowerCase() } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url), ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* OpenAlex：跨学科论文 + 引用 + 摘要                                   */
/* ------------------------------------------------------------------ */

/** OpenAlex 的摘要是「词 → 位置」倒排索引，拼回正常顺序 */
export function openAlexAbstract(index: unknown, maxChars = 500): string {
  const map = asRecord(index);
  const positions: [number, string][] = [];
  for (const [word, rawPositions] of Object.entries(map)) {
    for (const position of asArray(rawPositions)) {
      if (typeof position === 'number') positions.push([position, word]);
    }
  }
  if (positions.length === 0) return '';
  positions.sort((a, b) => a[0] - b[0]);
  return truncate(positions.map(([, word]) => word).join(' '), maxChars);
}

export const openAlexSource: ResearchSource = {
  id: 'openalex',
  label: 'OpenAlex 跨学科索引',
  routing: '跨学科论文、引用数、开放获取位置、作者机构；比 Crossref 多了摘要与引用量',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const params = [
      `search=${encodeQuery(input.query)}`,
      `per-page=${limitOf(input)}`,
      'select=id,doi,title,publication_year,authorships,abstract_inverted_index,primary_location,cited_by_count',
      ...(input.yearFrom ? [`filter=from_publication_date:${input.yearFrom}-01-01`] : []),
    ];
    const json = asRecord(await getJson(`https://api.openalex.org/works?${params.join('&')}`, ctx));
    const works = asArray(json.results);
    const total = asNumber(asRecord(json.meta).count);
    const hits: SourceHit[] = works.map((raw) => {
      const work = asRecord(raw);
      const doi = asString(work.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      const location = asRecord(work.primary_location);
      const sourceName = cleanText(asString(asRecord(location.source).display_name));
      const names = asArray(work.authorships).map((authorship) =>
        asString(asRecord(asRecord(authorship).author).display_name),
      );
      const abstract = openAlexAbstract(work.abstract_inverted_index);
      const url = doi ? `https://doi.org/${doi}` : asString(location.landing_page_url) || asString(work.id);
      return {
        title: cleanText(asString(work.title)) || '（无标题）',
        url,
        ...(abstract ? { snippet: abstract } : {}),
        meta: joinMeta([sourceName, asNumber(work.publication_year), authorsText(names), `引用 ${asNumber(work.cited_by_count) ?? 0}`]),
        ...(doi ? { dedupeKey: doi.toLowerCase() } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url), ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* Europe PMC：生物医学摘要 / 全文                                     */
/* ------------------------------------------------------------------ */

export const europePmcSource: ResearchSource = {
  id: 'europepmc',
  label: 'Europe PMC 生物医学',
  routing: '生物/医学论文的摘要与部分全文、引用；比 PubMed 多摘要且是 JSON',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const query = input.yearFrom ? `(${input.query}) AND (PUB_YEAR:[${input.yearFrom} TO 3000])` : input.query;
    const url =
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeQuery(query)}` +
      `&format=json&pageSize=${limitOf(input)}&resultType=core`;
    const json = asRecord(await getJson(url, ctx));
    const total = asNumber(json.hitCount);
    const results = asArray(asRecord(json.resultList).result);
    const hits: SourceHit[] = results.map((raw) => {
      const item = asRecord(raw);
      const doi = asString(item.doi);
      const pmid = asString(item.pmid);
      const source = asString(item.source);
      const id = asString(item.id);
      const url2 = doi
        ? `https://doi.org/${doi}`
        : pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
          : `https://europepmc.org/article/${source}/${id}`;
      const abstract = cleanText(asString(item.abstractText));
      return {
        title: cleanText(asString(item.title)) || '（无标题）',
        url: url2,
        ...(abstract ? { snippet: truncate(abstract, 400) } : {}),
        meta: joinMeta([asString(item.journalTitle), asString(item.pubYear), cleanText(asString(item.authorString))]),
        ...(doi ? { dedupeKey: doi.toLowerCase() } : {}),
      };
    });
    return { hits, ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* PubMed：NCBI E-utilities（题录）                                    */
/* ------------------------------------------------------------------ */

export const pubmedSource: ResearchSource = {
  id: 'pubmed',
  label: 'PubMed 医学题录',
  routing: '医学/生命科学文献的题录（期刊、年份、作者、PMID）；要摘要用 europepmc',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const esearchParams = [
      'db=pubmed',
      `term=${encodeQuery(input.query)}`,
      'retmode=json',
      `retmax=${limitOf(input)}`,
      'sort=relevance',
      'tool=aidocs',
      ...(input.yearFrom
        ? [`mindate=${input.yearFrom}`, `maxdate=${new Date().getFullYear()}`, 'datetype=pdat']
        : []),
    ];
    const searchJson = asRecord(await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${esearchParams.join('&')}`, ctx));
    const esearch = asRecord(searchJson.esearchresult);
    const ids = asArray(esearch.idlist).map(asString).filter(Boolean);
    const total = Number(asString(esearch.count));
    if (ids.length === 0) return { hits: [], ...(Number.isFinite(total) ? { note: `共 ${total} 条` } : {}) };

    const summaryJson = asRecord(
      await getJson(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json&tool=aidocs`,
        ctx,
      ),
    );
    const result = asRecord(summaryJson.result);
    const hits: SourceHit[] = ids.map((uid) => {
      const item = asRecord(result[uid]);
      const names = asArray(item.authors).map((author) => asString(asRecord(author).name));
      return {
        title: cleanText(asString(item.title)) || '（无标题）',
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
        meta: joinMeta([asString(item.source), asString(item.pubdate), authorsText(names)]),
        dedupeKey: `pmid:${uid}`,
      };
    });
    return { hits, ...(Number.isFinite(total) ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* DOAJ：开放获取期刊文章（含摘要）                                     */
/* ------------------------------------------------------------------ */

export const doajSource: ResearchSource = {
  id: 'doaj',
  label: 'DOAJ 开放获取期刊',
  routing: '开放获取（OA）期刊文章的标题、摘要、作者、全文链接；适合找可免费读的原文',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const url = `https://doaj.org/api/v3/search/articles/${encodeQuery(input.query)}?pageSize=${limitOf(input)}`;
    const json = asRecord(await getJson(url, ctx));
    const total = asNumber(json.total);
    const results = asArray(json.results);
    const hits: SourceHit[] = results.map((raw) => {
      const bib = asRecord(asRecord(raw).bibjson);
      const links = asArray(bib.link).map(asRecord);
      const identifiers = asArray(bib.identifier).map(asRecord);
      const doi = identifiers.find((item) => asString(item.type).toLowerCase() === 'doi');
      const doiValue = doi ? asString(doi.id) : '';
      const fulltext = links.find((link) => asString(link.type).toLowerCase() === 'fulltext') ?? links[0];
      const url2 = (fulltext ? asString(fulltext.url) : '') || (doiValue ? `https://doi.org/${doiValue}` : '');
      const names = asArray(bib.author).map((author) => asString(asRecord(author).name));
      const abstract = cleanText(asString(bib.abstract));
      return {
        title: cleanText(asString(bib.title)) || '（无标题）',
        url: url2,
        ...(abstract ? { snippet: truncate(abstract, 400) } : {}),
        meta: joinMeta([cleanText(asString(asRecord(bib.journal).title)), asString(bib.year), authorsText(names)]),
        ...(doiValue ? { dedupeKey: doiValue.toLowerCase() } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url), ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* arXiv：预印本（Atom XML）                                           */
/* ------------------------------------------------------------------ */

export interface AtomEntry {
  title: string;
  id: string;
  summary: string;
  published: string;
  authors: string[];
}

/** 只解析 arXiv Atom 里我们需要的字段；不是通用 XML 解析器 */
export function parseAtomEntries(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
  for (const block of blocks) {
    const pick = (tag: string): string => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return cleanText(match?.[1] ?? '');
    };
    const authorNames = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((match) =>
      cleanText(match[1] ?? ''),
    );
    entries.push({
      title: pick('title'),
      id: pick('id'),
      summary: pick('summary'),
      published: pick('published'),
      authors: authorNames,
    });
  }
  return entries;
}

export const arxivSource: ResearchSource = {
  id: 'arxiv',
  label: 'arXiv 预印本',
  routing: '物理/数学/计算机/统计/生物预印本（还没正式发表的论文）；官方要求低频，单次查询即可',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const url =
      `https://export.arxiv.org/api/query?search_query=all:${encodeQuery(input.query)}` +
      `&start=0&max_results=${limitOf(input)}&sortBy=relevance`;
    const xml = await getText(url, ctx);
    const entries = parseAtomEntries(xml);
    const hits: SourceHit[] = entries.map((entry) => ({
      title: entry.title || '（无标题）',
      url: entry.id,
      ...(entry.summary ? { snippet: truncate(entry.summary, 400) } : {}),
      meta: joinMeta([entry.published.slice(0, 10), authorsText(entry.authors)]),
      ...(entry.id ? { dedupeKey: entry.id } : {}),
    }));
    return { hits: hits.filter((hit) => hit.url) };
  },
};
