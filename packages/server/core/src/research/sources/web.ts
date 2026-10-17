import { DeepseekError, searchDeepseek } from '../../deepseek';
import { truncate } from '../http';
import type { ResearchSource, SourceContext, SourceSearchOutput } from '../types';

function clampCount(limit: number): number {
  return Math.min(20, Math.max(3, limit * 2));
}

/**
 * web 源 = DeepSeek 官方 Search/Fetch 的「搜索」部分。
 * 它是「必查源」：通用、最新、中文、新闻、百科类内容都靠它兜底。
 */
export const webSource: ResearchSource = {
  id: 'web',
  label: 'DeepSeek 联网搜索',
  routing: '通用/最新/中文/新闻/百科；不确定时先查它（每次搜索都会自动带上）',
  always: true,
  async search(input, ctx: SourceContext): Promise<SourceSearchOutput> {
    if (!ctx.deepseek) throw new DeepseekError(401, '未配置 DeepSeek API Key');
    const hits = await searchDeepseek(
      { query: input.query, count: clampCount(input.limit), needContent: false },
      {
        baseUrl: ctx.deepseek.baseUrl,
        apiKey: ctx.deepseek.apiKey,
        ...(ctx.deepseek.retries === undefined ? {} : { retries: ctx.deepseek.retries }),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    return {
      hits: hits.map((hit) => ({
        title: hit.title || '（无标题）',
        url: hit.url,
        ...(hit.summary || hit.snippet ? { snippet: truncate((hit.summary || hit.snippet).trim(), 400) } : {}),
        meta: [
          hit.siteName,
          hit.date ? hit.date.slice(0, 10) : null,
          hit.authority >= 0 ? `权威 ${hit.authority}/4` : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(' · '),
      })),
    };
  },
};
