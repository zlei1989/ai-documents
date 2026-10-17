import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '@aidocs/core';
import type { SaveProviderInput } from './providers';
import {
  clearDefaultModel,
  deleteModel,
  deleteProvider,
  importModels,
  listProviders,
  previewModels,
  saveModel,
  saveProvider,
  setDefaultModel,
  testProvider,
} from './providers';
import { ServiceError } from './service-error';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;

beforeEach(() => {
  env = isolateConfigDir();
});
afterEach(() => {
  env.restore();
});

function createProvider(overrides: Partial<SaveProviderInput> = {}) {
  return saveProvider({
    name: '测试供应商',
    protocol: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-secret-3a0f',
    ...overrides,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  throw new Error('期望抛出 ServiceError，但没有抛错');
}

describe('供应商', () => {
  it('下行视图只给掩码，明文密钥不泄漏', () => {
    createProvider();
    const [view] = listProviders();
    expect(view?.apiKey).toBe('sk-…3a0f');
    expect(JSON.stringify(view)).not.toContain('sk-secret-3a0f');
  });

  it('导入模型合并去重并落盘', () => {
    const provider = createProvider();
    importModels(provider.id, [{ id: 'gpt-4o-mini', name: 'mini' }]);

    const view = importModels(provider.id, [
      { id: 'gpt-4o-mini', name: '重复项' },
      { id: 'claude-x', contextWindow: 200_000, maxOutputTokens: 8_192, supportsImages: true },
    ]);

    expect(view.models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'claude-x']);
    expect(view.models.find((m) => m.id === 'claude-x')?.contextWindow).toBe(200_000);
    expect(view.models.find((m) => m.id === 'claude-x')?.supportsImages).toBe(true);
    const stored = readConfig().providers.find((p) => p.id === provider.id);
    expect(stored?.models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'claude-x']);
    expect(stored?.models.find((m) => m.id === 'claude-x')?.supportsImages).toBe(true);
  });

  it('手动保存模型：新增追加，同 id 整条替换并可清空能力字段', () => {
    const provider = createProvider();

    saveModel(provider.id, {
      id: 'vision',
      name: '显示名',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsImages: true,
    });
    saveModel(provider.id, { id: 'text-only' });

    const replaced = saveModel(provider.id, { id: 'vision', supportsImages: false });
    expect(replaced.models).toEqual([
      { id: 'vision', name: '显示名', supportsImages: false },
      { id: 'text-only' },
    ]);
    expect(readConfig().providers[0]?.models).toEqual([
      { id: 'vision', name: '显示名', supportsImages: false },
      { id: 'text-only' },
    ]);

    expect(codeOf(() => saveModel('missing', { id: 'x' }))).toBe('NOT_FOUND');
    expect(codeOf(() => saveModel(provider.id, { id: '  ' }))).toBe('VALIDATION');
  });

  it('删除模型：默认模型引用时拒绝，否则按 id 精确删除', () => {
    const provider = createProvider();
    importModels(provider.id, [{ id: 'm1' }, { id: 'org/m2' }]);
    setDefaultModel(provider.id, 'm1');

    expect(() => deleteModel(provider.id, 'm1')).toThrowError(/默认模型/);
    expect(codeOf(() => deleteModel(provider.id, 'm1'))).toBe('CONFLICT');

    clearDefaultModel();
    const view = deleteModel(provider.id, 'org/m2');
    expect(view.models.map((m) => m.id)).toEqual(['m1']);
    expect(readConfig().providers[0]?.models.map((m) => m.id)).toEqual(['m1']);

    expect(() => deleteModel(provider.id, 'missing')).toThrowError(/模型不存在/);
    expect(codeOf(() => deleteModel(provider.id, 'missing'))).toBe('NOT_FOUND');
    expect(codeOf(() => deleteModel('missing', 'm1'))).toBe('NOT_FOUND');
    expect(codeOf(() => deleteModel(provider.id, ''))).toBe('VALIDATION');
  });

  it('导入空列表与未知供应商都给出中文错误', () => {
    const provider = createProvider();
    expect(() => importModels(provider.id, [])).toThrowError(/至少选择一个模型/);
    expect(codeOf(() => importModels(provider.id, []))).toBe('VALIDATION');
    expect(() => importModels('missing', [{ id: 'x' }])).toThrowError(/供应商不存在/);
    expect(codeOf(() => importModels('missing', [{ id: 'x' }]))).toBe('NOT_FOUND');
  });

  it('设置默认模型落盘为 provider/model', () => {
    const provider = createProvider();
    importModels(provider.id, [{ id: 'gpt-4o-mini' }]);

    const settings = setDefaultModel(provider.id, 'gpt-4o-mini');

    expect(settings.defaultModel).toBe(`${provider.id}/gpt-4o-mini`);
    expect(readConfig().settings.defaultModel).toBe(`${provider.id}/gpt-4o-mini`);
    expect(clearDefaultModel().defaultModel).toBeNull();
  });

  it('默认模型必须来自已导入的模型列表', () => {
    const provider = createProvider();
    expect(() => setDefaultModel(provider.id, 'not-imported')).toThrowError(/请先在「模型」里添加或拉取模型/);
    expect(codeOf(() => setDefaultModel(provider.id, 'not-imported'))).toBe('VALIDATION');
    expect(codeOf(() => setDefaultModel('missing', 'm1'))).toBe('NOT_FOUND');
  });

  it('被默认模型引用的供应商不可删除', () => {
    const provider = createProvider();
    importModels(provider.id, [{ id: 'm1' }]);
    setDefaultModel(provider.id, 'm1');

    expect(() => deleteProvider(provider.id)).toThrowError(/默认模型/);
    expect(codeOf(() => deleteProvider(provider.id))).toBe('CONFLICT');
    expect(listProviders()).toHaveLength(1);

    clearDefaultModel();
    deleteProvider(provider.id);
    expect(listProviders()).toHaveLength(0);
  });

  it('删除不存在的供应商给出 NOT_FOUND', () => {
    expect(codeOf(() => deleteProvider('missing'))).toBe('NOT_FOUND');
  });

  it('测试调用：OpenAI Responses API 请求 /responses 并返回回复', async () => {
    let seen: { path?: string; body?: { model?: string; input?: string; store?: boolean } } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += String(chunk)));
      req.on('end', () => {
        seen = {
          path: req.url,
          body: JSON.parse(raw) as { model?: string; input?: string; store?: boolean },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: '连接成功' }] }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai' });
      importModels(provider.id, [{ id: 'gpt-mini' }]);

      const result = await testProvider(provider.id);

      expect(result.reply).toBe('连接成功');
      expect(result.model).toBe('gpt-mini');
      expect(seen.path).toBe('/v1/responses');
      expect(seen.body?.model).toBe('gpt-mini');
      expect(seen.body?.input).toBe('请只回复：连接成功');
      expect(seen.body?.store).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('拉取模型预览：openai 协议请求 /models 且不落盘', async () => {
    let seenPath: string | undefined;
    const server = createServer((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2', name: '二号' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai' });
      const list = await previewModels(provider.id);
      expect(list.map((model) => model.id)).toEqual(['m1', 'm2']);
      expect(seenPath).toBe('/v1/models');
      expect(readConfig().providers[0]?.models).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('拉取模型预览：从常见字段提取上下文窗口，导入后才落盘', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: 'a', context_length: 128_000 },
            { id: 'b', context_window: 200_000, top_provider: { context_length: 256_000 } },
            { id: 'c', model_info: { max_input_tokens: 65_536 } },
            { id: 'd', max_model_len: 32_768 },
            { id: 'e' },
            { id: 'f', context_length: '65536' },
            { id: 'g', context_length: 0 },
            { id: 'h', display_name: '显示名', limits: { max_context_window: 1_000_000 } },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai' });
      const list = await previewModels(provider.id);

      expect(list).toEqual([
        { id: 'a', contextWindow: 128_000 },
        { id: 'b', contextWindow: 200_000 },
        { id: 'c', contextWindow: 65_536 },
        { id: 'd', contextWindow: 32_768 },
        { id: 'e' },
        { id: 'f', contextWindow: 65_536 },
        { id: 'g' },
        { id: 'h', name: '显示名', contextWindow: 1_000_000 },
      ]);
      expect(readConfig().providers[0]?.models).toEqual([]);

      const view = importModels(provider.id, list.filter((model) => model.id === 'a'));
      expect(view.models[0]?.contextWindow).toBe(128_000);
      expect(readConfig().providers[0]?.models[0]?.contextWindow).toBe(128_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('拉取模型预览：anthropic 只填域名时自动补 /v1', async () => {
    let seenPath: string | undefined;
    const server = createServer((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}`, protocol: 'anthropic' });
      const list = await previewModels(provider.id);
      expect(list.map((model) => model.id)).toEqual(['claude-x']);
      expect(seenPath).toBe('/v1/models');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('测试调用：没有已导入模型时给中文错误', async () => {
    const provider = createProvider();
    await expect(testProvider(provider.id)).rejects.toThrowError(/请先在「模型」里添加或拉取模型/);
    await expect(testProvider('missing')).rejects.toThrowError(/供应商不存在/);
  });
});
