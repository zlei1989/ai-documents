import { sourceErrorReason } from './http';
import { arxivSource, crossrefSource, doajSource, europePmcSource, openAlexSource, pubmedSource } from './sources/academic';
import { eurostatSource, worldBankSource } from './sources/data';
import { clinicalTrialsSource, gbifSource } from './sources/life';
import { gutenbergSource } from './sources/books';
import { webSource } from './sources/web';
import type { ResearchSource, SourceContext, SourceResult, SourceSearchInput } from './types';

/**
 * 资料查询的源注册表。
 * 新增一个源 = 写一个适配器 + 加进这个数组；设置页/工具说明自动跟着变。
 * 顺序有意义：排在前面的源在跨源去重时优先。
 */
export const ALL_SOURCES: ResearchSource[] = [
  webSource,
  crossrefSource,
  openAlexSource,
  europePmcSource,
  pubmedSource,
  doajSource,
  arxivSource,
  gutenbergSource,
  gbifSource,
  clinicalTrialsSource,
  worldBankSource,
  eurostatSource,
];

export function getResearchSource(id: string): ResearchSource | undefined {
  return ALL_SOURCES.find((source) => source.id === id);
}

export function listResearchSources(): ResearchSource[] {
  return ALL_SOURCES;
}

/** 展示给设置页/模型的源清单（不含 search 实现） */
export function researchSourceInfos(): { id: string; label: string; routing: string; needsKey: boolean; always: boolean }[] {
  return ALL_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    routing: source.routing,
    needsKey: source.needsKey ?? false,
    always: source.always ?? false,
  }));
}

/**
 * 把模型传来的 source 列表规范化：
 * - 丢掉未知/被停用的 id；
 * - `always` 的源（DeepSeek 联网）永远排在第一位并强制带上。
 */
export function normalizeSourceIds(requested: string[], disabled: string[] = []): string[] {
  const disabledSet = new Set(disabled);
  const available = new Map(
    ALL_SOURCES.filter((source) => source.always || !disabledSet.has(source.id)).map((source) => [source.id, source]),
  );
  const always = ALL_SOURCES.filter((source) => source.always && available.has(source.id)).map((source) => source.id);
  const picked = requested.map((id) => id.trim()).filter((id) => available.has(id));
  return [...new Set([...always, ...picked])];
}

async function runSource(source: ResearchSource, input: SourceSearchInput, ctx: SourceContext): Promise<SourceResult> {
  const startedAt = Date.now();
  try {
    const output = await source.search(input, ctx);
    return {
      source: source.id,
      label: source.label,
      hits: output.hits.slice(0, input.limit),
      ...(output.note ? { note: output.note } : {}),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      source: source.id,
      label: source.label,
      hits: [],
      error: sourceErrorReason(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** 跨源去重：同一个 DOI/URL 只保留第一个源里的那一条 */
export function dedupeSourceResults(results: SourceResult[]): SourceResult[] {
  const seen = new Set<string>();
  return results.map((result) => {
    const hits = result.hits.filter((hit) => {
      const key = (hit.dedupeKey || hit.url || hit.title).trim().toLowerCase();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...result, hits };
  });
}

/** 并行查多个源；单源失败不影响其它源 */
export async function searchSources(
  ids: string[],
  input: SourceSearchInput,
  ctx: SourceContext = {},
): Promise<SourceResult[]> {
  const sources = ids.map(getResearchSource).filter((source): source is ResearchSource => Boolean(source));
  const results = await Promise.all(sources.map((source) => runSource(source, input, ctx)));
  return dedupeSourceResults(results);
}
