import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFile, updateConfig } from '@aidocs/core';
import { saveProvider } from './providers';
import { isDeepseekBaseUrl, resolveResearchConfig, testResearch } from './research';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;

beforeEach(() => {
  env = isolateConfigDir();
});
afterEach(() => {
  env.restore();
  vi.unstubAllGlobals();
});

function configureResearch(patch: Partial<{ providerId: string | null; baseUrl: string; count: number; needContent: boolean }> = {}) {
  updateConfig((config) => {
    config.settings.research = {
      ...config.settings.research,
      ...patch,
    };
  });
}

function deepseekProvider() {
  return saveProvider({
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-deepseek-3a0f',
  });
}

describe('resolveResearchConfig', () => {
  it('没有供应商 → broken（资料查询始终默认注入，没有关闭态）', () => {
    const resolution = resolveResearchConfig();
    expect(resolution.state).toBe('broken');
    if (resolution.state === 'broken') expect(resolution.reason).toContain('DeepSeek');
  });

  it('旧 config.json 里的 enabled=false 不再关闭资料查询', () => {
    deepseekProvider();
    // 模拟升级前落盘的配置：schema 已没有 enabled，读取时应被忽略
    const raw = JSON.parse(readFileSync(configFile(), 'utf8')) as {
      settings: { research: Record<string, unknown> };
    };
    raw.settings.research.enabled = false;
    writeFileSync(configFile(), JSON.stringify(raw, null, 2), 'utf8');

    expect(resolveResearchConfig().state).toBe('ready');
  });

  it('自动挑 baseUrl 指向 deepseek.com 的供应商，key 借用它的', () => {
    saveProvider({ name: '别家', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-other' });
    const provider = deepseekProvider();
    configureResearch({ count: 5, needContent: true });

    const resolution = resolveResearchConfig();
    expect(resolution.state).toBe('ready');
    if (resolution.state === 'ready') {
      expect(resolution.config).toEqual({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek-3a0f',
        count: 5,
        needContent: true,
        disabledSources: [],
      });
      expect(provider.id).toBeTruthy();
    }
  });

  it('指定 providerId 时以它为准，并可用 baseUrl 覆盖接口地址', () => {
    deepseekProvider();
    const other = saveProvider({ name: '网关', protocol: 'openai', baseUrl: 'https://relay.example.com', apiKey: 'sk-relay' });
    configureResearch({ providerId: other.id, baseUrl: 'https://relay.example.com/v1' });

    const resolution = resolveResearchConfig();
    expect(resolution.state).toBe('ready');
    if (resolution.state === 'ready') {
      expect(resolution.config.apiKey).toBe('sk-relay');
      expect(resolution.config.baseUrl).toBe('https://relay.example.com/v1');
    }
  });

  it('指定了不存在的供应商 → broken', () => {
    deepseekProvider();
    configureResearch({ providerId: 'missing' });
    const resolution = resolveResearchConfig();
    expect(resolution.state).toBe('broken');
    if (resolution.state === 'broken') expect(resolution.reason).toContain('不存在');
  });
});

describe('isDeepseekBaseUrl', () => {
  it('认官方与带 /v1 的地址，不认别家', () => {
    expect(isDeepseekBaseUrl('https://api.deepseek.com')).toBe(true);
    expect(isDeepseekBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(isDeepseekBaseUrl('https://api.example.com')).toBe(false);
    expect(isDeepseekBaseUrl('not a url')).toBe(false);
  });
});

describe('testResearch', () => {
  it('成功时返回样本，失败时给中文原因（都返回 200 结构）', async () => {
    deepseekProvider();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'DeepSeek', url: 'https://example.com' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await testResearch();
    expect(ok.ok).toBe(true);
    expect(ok.reason).toContain('连接成功');
    expect(ok.sample).toEqual({ title: 'DeepSeek', url: 'https://example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })),
    );
    const failed = await testResearch();
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain('API Key 无效');
  });

  it('没有供应商时直接给原因，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await testResearch();
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
