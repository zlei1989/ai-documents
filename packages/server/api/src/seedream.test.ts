import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropRuntime, putRuntime } from '@aidocs/agents';
import { readConfig, updateConfig } from '@aidocs/core';
import {
  getSeedreamView,
  resolveSeedreamConfig,
  saveSeedreamSettings,
  testSeedream,
} from './seedream';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;

beforeEach(() => {
  env = isolateConfigDir();
});
afterEach(() => {
  env.restore();
  dropRuntime('fake-doc');
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const requestInit = init ?? {};
    const method = (requestInit.method ?? 'GET').toUpperCase();
    let body: unknown = requestInit.body;
    if (typeof requestInit.body === 'string') {
      try {
        body = JSON.parse(requestInit.body) as unknown;
      } catch {
        body = requestInit.body;
      }
    }
    calls.push({ url, method, body });
    const response = handler(url, requestInit);
    if (!response) throw new Error(`没有为 ${method} ${url} 预置响应`);
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const KEY = 'ark-1234567890';

describe('生图设置', () => {
  it('默认关闭、默认 flash；没有独立的临时存储配置', () => {
    const view = getSeedreamView();
    expect(view.enabled).toBe(false);
    expect(view.model).toBe('doubao-seedream-5-0-flash-260915');
    expect(view.size).toBe('1536x1024');
    expect(view.hasKey).toBe(false);
    expect('tempStorageUrl' in view).toBe(false);
    expect(resolveSeedreamConfig().state).toBe('disabled');
  });

  it('保存后 ready；GET 视图只回掩码，config 里保留原 key', () => {
    const view = saveSeedreamSettings({ enabled: true, apiKey: KEY });
    expect(view.hasKey).toBe(true);
    expect(view.apiKey).not.toBe(KEY);
    expect(view.apiKey).toContain('…');
    expect(readConfig().seedream.apiKey).toBe(KEY);

    const resolution = resolveSeedreamConfig();
    expect(resolution.state).toBe('ready');
    if (resolution.state === 'ready') {
      expect(resolution.config).toEqual({
        apiKey: KEY,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-seedream-5-0-flash-260915',
        size: '1536x1024',
      });
    }
  });

  it('默认尺寸可保存，空值回落到 1536x1024', () => {
    saveSeedreamSettings({ enabled: true, apiKey: KEY, size: '2048x1152' });
    expect(readConfig().seedream.size).toBe('2048x1152');
    expect(getSeedreamView().size).toBe('2048x1152');

    saveSeedreamSettings({ size: '' });
    expect(readConfig().seedream.size).toBe('1536x1024');
  });

  it('apiKey 留空保持原值；启用时必须有 key；掩码字符串不能当 key 保存', () => {
    saveSeedreamSettings({ enabled: true, apiKey: KEY });
    saveSeedreamSettings({ baseUrl: 'https://ark.example/api/v3' });
    expect(readConfig().seedream.apiKey).toBe(KEY);
    expect(readConfig().seedream.baseUrl).toBe('https://ark.example/api/v3');

    expect(() => saveSeedreamSettings({ apiKey: 'ark…7890' })).toThrow('完整 API Key');

    updateConfig((config) => {
      config.seedream.apiKey = '';
    });
    expect(() => saveSeedreamSettings({ enabled: true })).toThrow('API Key');
  });

  it('配置不可用 → broken；关闭 → disabled', () => {
    updateConfig((config) => {
      config.seedream.enabled = true;
      config.seedream.apiKey = '';
    });
    const broken = resolveSeedreamConfig();
    expect(broken.state).toBe('broken');
    if (broken.state === 'broken') expect(broken.reason).toContain('API Key');

    updateConfig((config) => {
      config.seedream.enabled = false;
    });
    expect(resolveSeedreamConfig().state).toBe('disabled');
  });

  it('Base URL 不合法时 400 文案', () => {
    expect(() => saveSeedreamSettings({ baseUrl: 'ftp://ark.example' })).toThrow('http/https');
    expect(() => saveSeedreamSettings({ baseUrl: 'https://ark.example/api/v3?x=1' })).toThrow('查询串');
  });

  it('配置变化才释放在跑会话', () => {
    let disposed = 0;
    const putFake = () =>
      putRuntime('fake-doc', {
        dispose: () => {
          disposed += 1;
        },
      });

    putFake();
    saveSeedreamSettings({ apiKey: KEY });
    expect(disposed).toBe(1);

    putFake();
    saveSeedreamSettings({ apiKey: '' });
    expect(disposed).toBe(1);

    putFake();
    saveSeedreamSettings({ model: 'doubao-seedream-5-0-pro-260628' });
    expect(disposed).toBe(2);
  });
});

describe('测试连接与文件上传', () => {
  it('Ark 参数校验 400 视为鉴权通过；Files API 上传 + 预签名下载成功', async () => {
    saveSeedreamSettings({ enabled: true, apiKey: KEY });
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return json({ error: { code: 'InvalidParameter', message: 'size invalid' } }, 400);
      }
      if (method === 'POST' && url.endsWith('/files')) {
        return json({
          object: 'file',
          id: 'file-test',
          purpose: 'user_data',
          filename: 'hash',
          bytes: 68,
          mime_type: 'image/png',
          created_at: 1,
          expire_at: 2,
          status: 'active',
        });
      }
      return undefined;
    });

    const result = await testSeedream(fetchImpl);
    expect(result.arkOk).toBe(true);
    expect(result.reason).toContain('鉴权通过');
    expect(result.files?.ok).toBe(true);
    expect(result.files?.fileId).toBe('file-test');
    expect(result.files?.reason).toContain('file-test');
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/files'))).toBe(true);
    expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/images/generations'))?.body).toMatchObject({
      size: '1x1',
    });
  });

  it('Ark 401 + Files API 403 → 两项分别报错', async () => {
    saveSeedreamSettings({ enabled: true, apiKey: KEY });
    const { fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return json({ error: { code: 'AuthenticationError', message: 'bad' } }, 401);
      }
      if (method === 'POST' && url.endsWith('/files')) return new Response('denied', { status: 403 });
      return undefined;
    });
    const result = await testSeedream(fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.arkOk).toBe(false);
    expect(result.reason).toContain('API Key');
    expect(result.files?.ok).toBe(false);
    expect(result.files?.reason).toContain('Files API');
  });

  it('没有 key 时两项都返回未配置原因', async () => {
    const { fetchImpl } = stubFetch(() => undefined);
    const result = await testSeedream(fetchImpl);
    expect(result.arkOk).toBe(false);
    expect(result.reason).toContain('API Key');
    expect(result.files?.ok).toBe(false);
    expect(result.files?.reason).toContain('API Key');
    expect(result.ok).toBe(false);
  });
});
