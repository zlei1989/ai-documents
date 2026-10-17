import { randomUUID } from 'node:crypto';
import { ProviderSchema, type ModelInfo, type Provider, type ProviderView } from '@aidocs/contracts';
import { maskKey, readConfig, updateConfig, type AppConfig, type Settings } from '@aidocs/core';
import { ServiceError } from './service-error';

function toView(p: Provider): ProviderView {
  return { ...p, apiKey: maskKey(p.apiKey) };
}

export function listProviders(): ProviderView[] {
  return readConfig().providers.map(toView);
}

export interface SaveProviderInput {
  id?: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey?: string;
}

export function saveProvider(input: SaveProviderInput): ProviderView {
  const now = new Date().toISOString();
  let saved: Provider | undefined;
  updateConfig((config) => {
    if (input.id) {
      const idx = config.providers.findIndex((p: AppConfig['providers'][number]) => p.id === input.id);
      if (idx < 0) throw new ServiceError('NOT_FOUND', `供应商不存在：${input.id}`);
      const prev = config.providers[idx]!;
      const next: Provider = {
        ...prev,
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl.trim(),
        apiKey: input.apiKey && input.apiKey.length > 0 ? input.apiKey : prev.apiKey,
        updatedAt: now,
      };
      config.providers[idx] = ProviderSchema.parse(next);
      saved = config.providers[idx];
      return;
    }
    if (!input.apiKey) throw new ServiceError('VALIDATION', '新建供应商必须提供 API Key');
    const created: Provider = {
      id: randomUUID(),
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey,
      models: [],
      createdAt: now,
      updatedAt: now,
    };
    config.providers.push(ProviderSchema.parse(created));
    saved = config.providers.at(-1);
  });
  if (!saved) throw new ServiceError('INTERNAL', '保存供应商失败');
  return toView(saved);
}

export function deleteProvider(id: string): void {
  updateConfig((config) => {
    const idx = config.providers.findIndex((p: AppConfig['providers'][number]) => p.id === id);
    if (idx < 0) throw new ServiceError('NOT_FOUND', `供应商不存在：${id}`);
    // 引用检查（简化版）：只拦住被全局默认模型引用的供应商
    const ref = config.settings.defaultModel;
    if (ref && ref.startsWith(`${id}/`)) {
      const name = config.providers[idx]!.name;
      throw new ServiceError('CONFLICT', `供应商「${name}」正被全局默认模型引用，请先切换默认模型`);
    }
    config.providers.splice(idx, 1);
  });
}

/** 导入勾选的模型：按 id 合并去重，旧项保留（新元数据覆盖同名字段） */
export function importModels(id: string, models: ModelInfo[]): ProviderView {
  if (models.length === 0) throw new ServiceError('VALIDATION', '至少选择一个模型');
  let saved: Provider | undefined;
  updateConfig((config) => {
    const provider = config.providers.find((p: Provider) => p.id === id);
    if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${id}`);
    const merged = [...provider.models];
    for (const model of models) {
      const idx = merged.findIndex((m) => m.id === model.id);
      if (idx >= 0) merged[idx] = { ...merged[idx], ...model };
      else merged.push(model);
    }
    provider.models = merged;
    provider.updatedAt = new Date().toISOString();
    saved = provider;
  });
  if (!saved) throw new ServiceError('INTERNAL', '导入模型失败');
  return toView(saved);
}

/**
 * 手动新增/编辑单个模型：同 id 整条替换。
 * 替换而不是合并，才能把上下文窗口 / 最大输出 Tok 清空、把「支持图像」改回 false；
 * 只保留旧项的 name（手动表单不提交显示名）。
 */
export function saveModel(providerId: string, model: ModelInfo): ProviderView {
  const id = model.id.trim();
  if (!id) throw new ServiceError('VALIDATION', '模型名称不能为空');
  let saved: Provider | undefined;
  updateConfig((config) => {
    const provider = config.providers.find((p: Provider) => p.id === providerId);
    if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${providerId}`);
    const idx = provider.models.findIndex((m) => m.id === id);
    const prev = idx >= 0 ? provider.models[idx] : undefined;
    const name = model.name ?? prev?.name;
    const supportsImages = model.supportsImages ?? prev?.supportsImages;
    const next: ModelInfo = {
      id,
      ...(name !== undefined ? { name } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(supportsImages !== undefined ? { supportsImages } : {}),
    };
    if (idx >= 0) provider.models[idx] = next;
    else provider.models.push(next);
    provider.updatedAt = new Date().toISOString();
    saved = provider;
  });
  if (!saved) throw new ServiceError('INTERNAL', '保存模型失败');
  return toView(saved);
}

/** 删除单个已录入模型：按 id 精确删除；被全局默认模型引用时拒绝 */
export function deleteModel(providerId: string, modelId: string): ProviderView {
  if (!modelId) throw new ServiceError('VALIDATION', '缺少模型 id');
  let saved: Provider | undefined;
  updateConfig((config) => {
    const provider = config.providers.find((p: Provider) => p.id === providerId);
    if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${providerId}`);
    const idx = provider.models.findIndex((m) => m.id === modelId);
    if (idx < 0) throw new ServiceError('NOT_FOUND', `模型不存在：${modelId}`);
    if (config.settings.defaultModel === `${provider.id}/${modelId}`) {
      throw new ServiceError('CONFLICT', `模型「${modelId}」正被全局默认模型引用，请先切换默认模型`);
    }
    provider.models.splice(idx, 1);
    provider.updatedAt = new Date().toISOString();
    saved = provider;
  });
  if (!saved) throw new ServiceError('INTERNAL', '删除模型失败');
  return toView(saved);
}

/** 全局默认模型：落盘格式 `providerId/modelId` */
export function setDefaultModel(providerId: string, modelId: string): Settings {
  let next: Settings | undefined;
  updateConfig((config) => {
    const provider = config.providers.find((p: Provider) => p.id === providerId);
    if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${providerId}`);
    if (!modelId) throw new ServiceError('VALIDATION', '请选择模型');
    if (!provider.models.some((m) => m.id === modelId)) {
      throw new ServiceError('VALIDATION', `模型未导入：${modelId}，请先在「模型」里添加或拉取模型`);
    }
    config.settings.defaultModel = `${provider.id}/${modelId}`;
    next = config.settings;
  });
  if (!next) throw new ServiceError('INTERNAL', '保存默认模型失败');
  return next;
}

/** settings 里 `providerId/modelId` 字符串形态的入口（modelId 允许再含 /） */
export function setDefaultModelRef(ref: string | null): Settings {
  if (ref === null) return clearDefaultModel();
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new ServiceError('VALIDATION', '默认模型格式应为 providerId/modelId');
  }
  return setDefaultModel(ref.slice(0, slash), ref.slice(slash + 1));
}

export function clearDefaultModel(): Settings {
  let next: Settings | undefined;
  updateConfig((config) => {
    config.settings.defaultModel = null;
    next = config.settings;
  });
  if (!next) throw new ServiceError('INTERNAL', '清除默认模型失败');
  return next;
}

/** 远端 /models 响应里常见的上下文窗口字段（顶层或嵌套容器内） */
const CONTEXT_WINDOW_KEYS = [
  'context_length',
  'context_window',
  'context_window_size',
  'max_context_length',
  'max_context_window',
  'max_context_tokens',
  'max_model_len',
  'max_sequence_length',
  'model_max_length',
  'max_input_tokens',
  'input_token_limit',
  'inputTokenLimit',
  'context_size',
  'n_ctx',
];
const CONTEXT_WINDOW_CONTAINERS = ['top_provider', 'model_info', 'limits', 'meta', 'metadata', 'capabilities'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveIntValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 各家 /models 字段名不一致：顶层和常见嵌套容器都找一遍，取第一个合法正整数 */
function remoteContextWindow(entry: Record<string, unknown>): number | undefined {
  const containers = [entry];
  for (const key of CONTEXT_WINDOW_CONTAINERS) {
    const nested = asRecord(entry[key]);
    if (nested) containers.push(nested);
  }
  for (const container of containers) {
    for (const key of CONTEXT_WINDOW_KEYS) {
      const found = positiveIntValue(container[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function remoteDisplayName(entry: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'display_name']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 拉模型：preview 阶段只读远端，import 阶段才落盘；上下文窗口随预览一起返回 */
export async function previewModels(id: string): Promise<ModelInfo[]> {
  const provider = readConfig().providers.find((p: AppConfig['providers'][number]) => p.id === id);
  if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${id}`);
  const base = provider.baseUrl.replace(/\/+$/, '');
  const url =
    provider.protocol === 'anthropic'
      ? `${base.endsWith('/v1') ? base : `${base}/v1`}/models`
      : `${base}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers:
        provider.protocol === 'anthropic'
          ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ServiceError('INTERNAL', `拉取模型失败：无法连接 ${url}`, { cause: String(error) });
  }
  if (!res.ok) throw new ServiceError('INTERNAL', `拉取模型失败：HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  const root = asRecord(json);
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : [];
  const models: ModelInfo[] = [];
  for (const row of rows) {
    const entry = asRecord(row);
    if (!entry) continue;
    const rawId = entry.id;
    const modelId = typeof rawId === 'string' ? rawId.trim() : typeof rawId === 'number' ? String(rawId) : '';
    if (!modelId) continue;
    const name = remoteDisplayName(entry);
    const contextWindow = remoteContextWindow(entry);
    models.push({
      id: modelId,
      ...(name ? { name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }
  return models;
}

export interface ProviderTestResult {
  reply: string;
  model: string;
  latencyMs: number;
}

/** 测试调用：用已导入的第一个（或全局默认）模型按协议发一次最小请求，验证 key/baseUrl 可用 */
export async function testProvider(id: string): Promise<ProviderTestResult> {
  const config = readConfig();
  const provider = config.providers.find((p: Provider) => p.id === id);
  if (!provider) throw new ServiceError('NOT_FOUND', `供应商不存在：${id}`);
  const model = pickTestModel(config, provider);

  const base = provider.baseUrl.replace(/\/+$/, '');
  const startedAt = Date.now();
  let res: Response;
  try {
    if (provider.protocol === 'anthropic') {
      const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: '请只回复：连接成功' }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      res = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: '请只回复：连接成功',
          max_output_tokens: 256,
          store: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    }
  } catch (error) {
    throw new ServiceError('INTERNAL', `测试调用失败：无法连接 ${base}`, { cause: String(error) });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ServiceError('INTERNAL', `测试调用失败：HTTP ${res.status}`, { body: body.slice(0, 800) });
  }
  const json = (await res.json().catch(() => null)) as unknown;
  const reply = provider.protocol === 'anthropic' ? anthropicText(json) : openAiResponsesText(json);
  if (!reply) throw new ServiceError('INTERNAL', '测试调用失败：响应中没有文本内容');
  return { reply, model, latencyMs: Date.now() - startedAt };
}

function pickTestModel(config: AppConfig, provider: Provider): string {
  const ref = config.settings.defaultModel;
  if (ref && ref.startsWith(`${provider.id}/`)) {
    const id = ref.slice(provider.id.length + 1);
    if (provider.models.some((m) => m.id === id)) return id;
  }
  const first = provider.models[0]?.id;
  if (!first) throw new ServiceError('VALIDATION', '请先在「模型」里添加或拉取模型，再测试调用');
  return first;
}

function anthropicText(json: unknown): string {
  const blocks = (json as { content?: { type?: string; text?: string }[] })?.content ?? [];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

function openAiResponsesText(json: unknown): string {
  const payload = json as {
    output_text?: unknown;
    output?: { content?: { type?: string; text?: string }[] }[];
  };
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of payload?.output ?? []) {
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('').trim();
}
