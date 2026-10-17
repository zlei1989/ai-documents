/** 资料查询数据源的公共类型。适配器只依赖 fetch，不依赖 pi。 */

export interface SourceHit {
  title: string;
  url: string;
  /** 摘要 / 正文片段（会截断后给模型看） */
  snippet?: string;
  /** 期刊、年份、作者、站点等一行元信息 */
  meta?: string;
  /** 可直接抓取的全文地址（公版书、开放获取全文等） */
  fullTextUrl?: string;
  /** 跨源去重键（DOI 或规范化 URL）；不给就用 url */
  dedupeKey?: string;
}

export interface SourceSearchInput {
  query: string;
  /** 每个源最多返回多少条（1–10） */
  limit: number;
  /** 只看这一年及以后 */
  yearFrom?: number;
}

export interface SourceSearchOutput {
  hits: SourceHit[];
  /** 该源的总命中数说明，如「共 15,032 条」 */
  note?: string;
}

export interface SourceContext {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 单源超时（毫秒），默认 15s */
  timeoutMs?: number;
  /** DeepSeek 联网搜索的凭据（web 源专用） */
  deepseek?: { baseUrl: string; apiKey: string; retries?: number };
}

export interface ResearchSource {
  id: string;
  label: string;
  /** 什么类型的内容该查它 —— 会原样教给模型 */
  routing: string;
  needsKey?: boolean;
  /** true = 每次 research_search 都会带上（DeepSeek 联网搜索） */
  always?: boolean;
  search(input: SourceSearchInput, ctx: SourceContext): Promise<SourceSearchOutput>;
}

export interface SourceResult {
  source: string;
  label: string;
  hits: SourceHit[];
  note?: string;
  /** 该源失败时的中文原因（不影响其它源） */
  error?: string;
  elapsedMs: number;
}
