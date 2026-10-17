import { resetAllRuntimes } from '@aidocs/agents';
import {
  SEEDREAM_DEFAULT_BASE_URL,
  SEEDREAM_DEFAULT_MODEL,
  SEEDREAM_DEFAULT_SIZE,
  type SeedreamPatch,
  type SeedreamTestResult,
  type SeedreamView,
} from '@aidocs/contracts';
import {
  arkFilesReason,
  maskKey,
  readConfig,
  seedreamImagesUrl,
  seedreamReason,
  updateConfig,
  uploadArkFile,
  type AppConfig,
} from '@aidocs/core';
import { ServiceError } from './service-error';

export type SeedreamResolution =
  | { state: 'disabled' }
  | { state: 'ready'; config: SeedreamToolConfig }
  | { state: 'broken'; reason: string };

export interface SeedreamToolConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
}

/** 下行视图：key 只回掩码 */
export function getSeedreamView(config: AppConfig = readConfig()): SeedreamView {
  const value = config.seedream;
  return {
    ...value,
    apiKey: maskKey(value.apiKey),
    hasKey: value.apiKey.trim().length > 0,
  };
}

/**
 * 启用与否 + 配置是否完整：
 * - disabled：没启用，工具不注入；
 * - broken：启用了但缺 key/baseUrl/model，调用方降级为无工具 + warn；
 * - ready：可用。参考图上传复用同一个 baseUrl/apiKey 的 Files API。
 */
export function resolveSeedreamConfig(config: AppConfig = readConfig()): SeedreamResolution {
  const value = config.seedream;
  if (!value.enabled) return { state: 'disabled' };
  const baseUrl = value.baseUrl.trim() || SEEDREAM_DEFAULT_BASE_URL;
  const model = value.model.trim() || SEEDREAM_DEFAULT_MODEL;
  const size = value.size.trim() || SEEDREAM_DEFAULT_SIZE;
  const apiKey = value.apiKey.trim();
  if (!baseUrl) return { state: 'broken', reason: 'Base URL 为空' };
  if (!model) return { state: 'broken', reason: '默认模型为空' };
  if (!size) return { state: 'broken', reason: '默认尺寸为空' };
  if (!apiKey) return { state: 'broken', reason: '还没有填写 API Key' };
  try {
    seedreamImagesUrl(baseUrl);
  } catch (error) {
    return { state: 'broken', reason: seedreamReason(error) };
  }
  return { state: 'ready', config: { baseUrl, apiKey, model, size } };
}

function assertHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServiceError('VALIDATION', `${label}不合法：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServiceError('VALIDATION', `${label}只支持 http/https`);
  }
  if (parsed.username || parsed.password) {
    throw new ServiceError('VALIDATION', `${label}不能携带用户名或密码`);
  }
  if (parsed.search || parsed.hash) {
    throw new ServiceError('VALIDATION', `${label}不能带查询串或锚点`);
  }
}

/** PUT /api/seedream：合并保存；apiKey 空 = 保持原值；内容变化才重建会话 */
export function saveSeedreamSettings(patch: SeedreamPatch): SeedreamView {
  let next: SeedreamView | undefined;
  let changed = false;
  updateConfig((config) => {
    const before = JSON.stringify(config.seedream);
    const prev = config.seedream;
    const apiKey = patch.apiKey?.trim() ?? '';
    if (apiKey && (apiKey.includes('…') || apiKey.includes('••••'))) {
      throw new ServiceError('VALIDATION', '请重新输入完整 API Key（界面只回显掩码）');
    }
    const merged = {
      enabled: patch.enabled ?? prev.enabled,
      baseUrl: (patch.baseUrl ?? prev.baseUrl).trim(),
      model: (patch.model ?? prev.model).trim(),
      size: (patch.size ?? prev.size).trim() || SEEDREAM_DEFAULT_SIZE,
      apiKey: apiKey || prev.apiKey,
    };
    if (!merged.baseUrl) throw new ServiceError('VALIDATION', 'Base URL 不能为空');
    if (!merged.model) throw new ServiceError('VALIDATION', '默认模型不能为空');
    if (!merged.size) throw new ServiceError('VALIDATION', '默认尺寸不能为空');
    assertHttpUrl(merged.baseUrl, 'Base URL');
    try {
      seedreamImagesUrl(merged.baseUrl);
    } catch (error) {
      throw new ServiceError('VALIDATION', seedreamReason(error));
    }
    if (merged.enabled && !merged.apiKey.trim()) {
      throw new ServiceError('VALIDATION', '启用火山引擎前请先填写 API Key');
    }
    config.seedream = merged;
    next = getSeedreamView({ ...config, seedream: merged });
    changed = JSON.stringify(config.seedream) !== before;
  });
  if (!next) throw new ServiceError('INTERNAL', '保存生图设置失败');
  // 只有配置真的变化才释放在跑会话；下一轮按新配置重建（历史靠会话文件续接）
  if (changed) resetAllRuntimes();
  return next;
}

/* ---------------- 测试连接与文件上传 ---------------- */

const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface ProbeResult {
  ok: boolean;
  reason: string;
  latencyMs: number;
}

async function probeArk(
  config: AppConfig['seedream'],
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const apiKey = config.apiKey.trim();
  if (!apiKey) return { ok: false, reason: '还没有保存 API Key', latencyMs: 0 };
  let url: string;
  try {
    url = seedreamImagesUrl(config.baseUrl);
  } catch (error) {
    return { ok: false, reason: seedreamReason(error), latencyMs: Date.now() - startedAt };
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      // 故意用非法尺寸：只验证鉴权/连通，不会生成图片、不计费
      body: JSON.stringify({
        model: config.model,
        prompt: '连接测试',
        size: '1x1',
        response_format: 'url',
        watermark: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const elapsedMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    const { code, message } = extractError(text);
    if (response.ok) return { ok: true, reason: '连接成功（服务端接受了探测请求）', latencyMs: elapsedMs };
    if (response.status === 401) {
      return { ok: false, reason: 'API Key 无效或未授权，请检查 Key', latencyMs: elapsedMs };
    }
    if (response.status === 403) {
      return {
        ok: false,
        reason: `API Key 无权限或模型未开通${message ? `（${message}）` : ''}`,
        latencyMs: elapsedMs,
      };
    }
    if (response.status === 404 || code === 'ModelNotFound') {
      return {
        ok: false,
        reason: `接口或模型不存在：请检查 Base URL 与模型 ID${message ? `（${message}）` : ''}`,
        latencyMs: elapsedMs,
      };
    }
    if (response.status === 429) {
      return { ok: true, reason: '鉴权通过（当前被限流）', latencyMs: elapsedMs };
    }
    if (response.status >= 500) {
      return { ok: false, reason: `火山引擎服务暂时不可用（HTTP ${response.status}）`, latencyMs: elapsedMs };
    }
    return {
      ok: true,
      reason: `鉴权通过，未生成图片（参数校验返回 HTTP ${response.status}${message ? `：${message}` : ''}）`,
      latencyMs: elapsedMs,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as Error)?.name === 'TimeoutError'
          ? '连接火山引擎超时'
          : `无法连接火山引擎：${(error as Error)?.message ?? String(error)}`,
      latencyMs: Date.now() - startedAt,
    };
  }
}

function extractError(raw: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    return { code: parsed.error?.code ?? '', message: parsed.error?.message ?? parsed.error?.code ?? '' };
  } catch {
    return { code: '', message: raw.slice(0, 200) };
  }
}

async function probeFiles(
  config: AppConfig['seedream'],
  fetchImpl: typeof fetch,
): Promise<NonNullable<SeedreamTestResult['files']>> {
  const startedAt = Date.now();
  const apiKey = config.apiKey.trim();
  if (!apiKey) return { ok: false, reason: '还没有保存 API Key', fileId: null, latencyMs: 0 };
  try {
    const file = await uploadArkFile(TEST_PNG, 'image/png', {
      baseUrl: config.baseUrl,
      apiKey,
      fetchImpl,
      timeoutMs: 20_000,
    });
    return {
      ok: true,
      reason: `上传成功（${file.id}，1 天后过期）`,
      fileId: file.id,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      reason: arkFilesReason(error),
      fileId: null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** POST /api/seedream/test：Ark 鉴权探针 + Files API 上传/预签名下载探针 */
export async function testSeedream(fetchImpl: typeof fetch = fetch): Promise<SeedreamTestResult> {
  const config = readConfig().seedream;
  const [ark, files] = await Promise.all([probeArk(config, fetchImpl), probeFiles(config, fetchImpl)]);
  const ok = ark.ok && files.ok;
  return {
    ok,
    arkOk: ark.ok,
    reason: ark.reason,
    // 显示在「模型接口」那一行，用 Ark 自己的耗时；Files API 有独立耗时
    latencyMs: ark.latencyMs,
    model: config.model.trim() || SEEDREAM_DEFAULT_MODEL,
    files,
  };
}
