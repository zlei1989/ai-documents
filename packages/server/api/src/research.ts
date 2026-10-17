import type { ResearchSourceInfo, ResearchTestInput, ResearchTestResult } from '@aidocs/contracts';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  deepseekReason,
  readConfig,
  researchSourceInfos,
  searchDeepseek,
  type AppConfig,
} from '@aidocs/core';

export interface ResearchToolConfig {
  baseUrl: string;
  apiKey: string;
  count: number;
  needContent: boolean;
  /** 设置页里停用的数据源 id（web 始终可用） */
  disabledSources: string[];
}

export type ResearchResolution =
  | { state: 'ready'; config: ResearchToolConfig }
  | { state: 'broken'; reason: string };

/** GET /api/research/sources：设置页与模型看到的是同一份源清单 */
export function listResearchSources(): ResearchSourceInfo[] {
  return researchSourceInfos();
}

/**
 * 把设置解析成「能不能用」两态（资料查询默认注入，没有关闭态）：
 * - ready：可用（key 从所选供应商借用）；
 * - broken：配置不完整 —— 调用方降级为无工具 + 一条 warn notice，不阻塞创作。
 */
export function resolveResearchConfig(config: AppConfig = readConfig()): ResearchResolution {
  const research = config.settings.research;
  const provider = pickProvider(config, research.providerId);
  if (!provider) {
    return {
      state: 'broken',
      reason: research.providerId
        ? `所选供应商不存在：${research.providerId}`
        : '没有可用的 DeepSeek 供应商（请到「模型供应商」添加 DeepSeek，或在资料查询里选一条供应商）',
    };
  }
  const apiKey = provider.apiKey.trim();
  if (!apiKey) return { state: 'broken', reason: `供应商「${provider.name}」没有 API Key` };

  const baseUrl = research.baseUrl.trim() || provider.baseUrl.trim() || DEEPSEEK_DEFAULT_BASE_URL;
  return {
    state: 'ready',
    config: {
      baseUrl,
      apiKey,
      count: research.count,
      needContent: research.needContent,
      disabledSources: research.disabledSources,
    },
  };
}

function pickProvider(config: AppConfig, providerId: string | null): AppConfig['providers'][number] | undefined {
  if (providerId) return config.providers.find((item) => item.id === providerId);
  return config.providers.find((item) => isDeepseekBaseUrl(item.baseUrl));
}

/** 自动挑供应商时只认指向 api.deepseek.com 的地址（含 /v1、网关前缀） */
export function isDeepseekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().endsWith('deepseek.com');
  } catch {
    return false;
  }
}

/** 设置页「测试连接」：真打一次 Search，失败也返回 200 + 中文原因（对齐 MCP 探针风格） */
export async function testResearch(input: ResearchTestInput = {}): Promise<ResearchTestResult> {
  const config = readConfig();
  const providerId = input.providerId === undefined ? config.settings.research.providerId : input.providerId;
  const provider = pickProvider(config, providerId);
  const startedAt = Date.now();
  if (!provider) {
    return {
      ok: false,
      reason: providerId ? `所选供应商不存在：${providerId}` : '没有可用的 DeepSeek 供应商',
      latencyMs: 0,
      sample: null,
    };
  }
  const baseUrl = input.baseUrl?.trim() || config.settings.research.baseUrl.trim() || DEEPSEEK_DEFAULT_BASE_URL;
  try {
    const hits = await searchDeepseek(
      { query: 'DeepSeek', count: 1 },
      { baseUrl, apiKey: provider.apiKey, retries: 0 },
    );
    const first = hits[0];
    return {
      ok: true,
      reason: first ? `连接成功，搜索返回：${first.title || first.url}` : '连接成功，但本次搜索没有结果',
      latencyMs: Date.now() - startedAt,
      sample: first ? { title: first.title, url: first.url } : null,
    };
  } catch (error) {
    return { ok: false, reason: deepseekReason(error), latencyMs: Date.now() - startedAt, sample: null };
  }
}
