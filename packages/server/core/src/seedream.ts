import { z } from 'zod';
import { arkApiBase } from './ark';

/**
 * 火山引擎 Ark「图片生成」客户端（Seedream 5.0 / 4.5 / 4.0）。
 *
 * 只负责 HTTP / SSE 与错误翻译；模式推断、模型能力校验、参考图上传、落盘都在
 * `@aidocs/agents` 的 seedream 工具里做。
 */

export class SeedreamError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'SeedreamError';
    this.status = status;
    this.code = code;
  }
}

export interface SeedreamRequest {
  model: string;
  prompt?: string;
  image?: string | string[];
  size?: string;
  output_format?: 'png' | 'jpeg';
  background?: 'transparent' | 'opaque';
  sequential_image_generation?: 'auto' | 'disabled';
  sequential_image_generation_options?: { max_images?: number };
  stream?: boolean;
  tools?: { type: 'web_search' }[];
  layer_decomposition?: boolean;
  response_format?: 'url' | 'b64_json';
  watermark?: boolean;
}

export interface SeedreamBoundingBox {
  absolute: number[];
  normalized: number[];
}

export interface SeedreamImage {
  /** 组图里的位置；非组图为 null */
  imageIndex: number | null;
  url: string | null;
  b64: string | null;
  size: string | null;
  outputFormat: 'png' | 'jpeg' | null;
  zIndex: number | null;
  name: string | null;
  description: string | null;
  boundingBox: SeedreamBoundingBox | null;
  error: { code: string; message: string } | null;
}

export interface SeedreamUsage {
  generatedImages: number;
  inputImages: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  webSearch: number | null;
}

export interface SeedreamResponse {
  model: string;
  created: number | null;
  images: SeedreamImage[];
  usage: SeedreamUsage;
  streamed: boolean;
}

export interface SeedreamOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 整次生成（含流式读取）的超时，默认 10 分钟 */
  timeoutMs?: number;
  /** 流式：每张图生成成功时回调（工具用来更新 UI/收集） */
  onPartial?: (image: SeedreamImage) => void | Promise<void>;
}

/* ---------------- 响应 schema ---------------- */

const BoundingBoxSchema = z.object({
  absolute: z.array(z.number()).default([]),
  normalized: z.array(z.number()).default([]),
});

const ImageDataSchema = z.object({
  url: z.string().optional(),
  b64_json: z.string().optional(),
  size: z.string().optional(),
  output_format: z.string().optional(),
  image_index: z.number().int().optional(),
  z_index: z.number().int().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  bounding_box: BoundingBoxSchema.optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const UsageSchema = z
  .object({
    generated_images: z.number().int().optional(),
    input_images: z.number().int().optional(),
    output_tokens: z.number().int().optional(),
    total_tokens: z.number().int().optional(),
    tool_usage: z.object({ web_search: z.number().int().optional() }).optional(),
  })
  .optional();

const NonStreamResponseSchema = z.object({
  model: z.string().optional(),
  created: z.number().optional(),
  data: z.array(ImageDataSchema).default([]),
  usage: UsageSchema,
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const StreamEventSchema = z.object({
  type: z.string().optional(),
  model: z.string().optional(),
  created: z.number().optional(),
  image_index: z.number().int().optional(),
  url: z.string().optional(),
  b64_json: z.string().optional(),
  size: z.string().optional(),
  output_format: z.string().optional(),
  z_index: z.number().int().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  bounding_box: BoundingBoxSchema.optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  usage: UsageSchema,
});

/* ---------------- 地址与错误 ---------------- */

/** `{base}/images/generations`；只填域名时自动补 /api/v3 */
export function seedreamImagesUrl(baseUrl: string): string {
  try {
    return `${arkApiBase(baseUrl)}/images/generations`;
  } catch (error) {
    throw new SeedreamError(400, (error as Error).message);
  }
}

function parseError(raw: string): { code?: string; message: string } {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    const code = parsed.error?.code ?? parsed.code;
    const message = parsed.error?.message ?? parsed.message;
    if (message || code) return { ...(code ? { code } : {}), message: message ?? code ?? raw.slice(0, 200) };
  } catch {
    /* 非 JSON */
  }
  return { message: raw.slice(0, 300) };
}

function normalizeFormat(value: string | undefined): 'png' | 'jpeg' | null {
  if (value === 'png') return 'png';
  if (value === 'jpeg' || value === 'jpg') return 'jpeg';
  return null;
}

function toImage(data: z.infer<typeof ImageDataSchema>, fallbackIndex: number | null = null): SeedreamImage {
  const error = data.error
    ? { code: data.error.code ?? 'UnknownError', message: data.error.message ?? '' }
    : null;
  return {
    imageIndex: typeof data.image_index === 'number' ? data.image_index : fallbackIndex,
    url: data.url ?? null,
    b64: data.b64_json ?? null,
    size: data.size ?? null,
    outputFormat: normalizeFormat(data.output_format),
    zIndex: typeof data.z_index === 'number' ? data.z_index : null,
    name: data.name ?? null,
    description: data.description ?? null,
    boundingBox: data.bounding_box
      ? { absolute: data.bounding_box.absolute, normalized: data.bounding_box.normalized }
      : null,
    error,
  };
}

function toUsage(raw: z.infer<typeof UsageSchema>): SeedreamUsage {
  return {
    generatedImages: raw?.generated_images ?? 0,
    inputImages: raw?.input_images ?? null,
    outputTokens: raw?.output_tokens ?? null,
    totalTokens: raw?.total_tokens ?? null,
    webSearch: raw?.tool_usage?.web_search ?? null,
  };
}

async function readErrorBody(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

function requestSignal(options: SeedreamOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000);
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

async function post(request: SeedreamRequest, options: SeedreamOptions): Promise<Response> {
  if (options.signal?.aborted) throw new SeedreamError(0, '请求已取消');
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(seedreamImagesUrl(options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...(request.stream ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(request),
      signal: requestSignal(options),
    });
  } catch (error) {
    if (error instanceof SeedreamError) throw error;
    if (options.signal?.aborted) throw new SeedreamError(0, '请求已取消');
    if ((error as Error)?.name === 'TimeoutError') throw new SeedreamError(0, '生成超时（未在时限内返回）');
    throw new SeedreamError(0, `无法连接图片生成接口：${(error as Error)?.message ?? String(error)}`);
  }
}

/* ---------------- 非流式 ---------------- */

async function readNonStream(response: Response, model: string): Promise<SeedreamResponse> {
  const text = await response.text().catch(() => '');
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new SeedreamError(500, `图片生成接口返回的不是合法 JSON：${text.slice(0, 200)}`);
  }
  const parsed = NonStreamResponseSchema.safeParse(payload);
  if (!parsed.success) throw new SeedreamError(500, '图片生成接口返回格式不符合预期', 'bad_schema');
  const body = parsed.data;
  if (body.error && body.data.length === 0) {
    const message = body.error.message ?? body.error.code ?? '图片生成失败';
    throw new SeedreamError(400, message, body.error.code);
  }
  return {
    model: body.model ?? model,
    created: body.created ?? null,
    images: body.data.map((item, index) => toImage(item, index)),
    usage: toUsage(body.usage),
    streamed: false,
  };
}

/* ---------------- 流式 ---------------- */

interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split('\n');
  let event = '';
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

async function readStream(
  response: Response,
  request: SeedreamRequest,
  options: SeedreamOptions,
): Promise<SeedreamResponse> {
  const body = response.body;
  if (!body) throw new SeedreamError(500, '图片生成接口没有返回流式响应体');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let model = request.model;
  let created: number | null = null;
  let usage = toUsage(undefined);
  let completed = false;
  let topError: SeedreamError | null = null;
  const byIndex = new Map<number, SeedreamImage>();
  const ordered: SeedreamImage[] = [];

  const accept = (image: SeedreamImage): void => {
    if (image.imageIndex !== null) byIndex.set(image.imageIndex, image);
    else ordered.push(image);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const frameText = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        const frame = parseFrame(frameText);
        if (!frame) continue;
        if (frame.data.trim() === '[DONE]') {
          completed = true;
          break;
        }
        let payload: z.infer<typeof StreamEventSchema>;
        try {
          payload = StreamEventSchema.parse(JSON.parse(frame.data));
        } catch {
          continue; // 未知帧跳过，不让单个坏帧打断整条流
        }
        const type = payload.type ?? frame.event;
        model = payload.model ?? model;
        created = payload.created ?? created;
        if (type === 'image_generation.partial_succeeded') {
          const image = toImage(payload);
          accept(image);
          await options.onPartial?.(image);
        } else if (type === 'image_generation.partial_failed') {
          const image = toImage(payload);
          accept(image);
          if ((payload.error?.code ?? '') === 'InternalServiceError') {
            throw new SeedreamError(500, payload.error?.message ?? '图片生成服务内部错误', payload.error?.code);
          }
        } else if (type === 'image_generation.completed') {
          usage = toUsage(payload.usage);
          completed = true;
        } else if (type === 'error') {
          const code = payload.error?.code;
          const message = payload.error?.message ?? code ?? '图片生成失败';
          topError = new SeedreamError(code === 'AuthenticationError' ? 401 : 400, message, code);
          throw topError;
        }
      }
      if (completed) break;
    }
    // 某些网关最后一帧没有补 \n\n：收尾时再解析一次
    if (!completed && buffer.trim()) {
      const frame = parseFrame(buffer.replace(/\r\n/g, '\n'));
      buffer = '';
      if (frame) {
        if (frame.data.trim() === '[DONE]') {
          completed = true;
        } else {
          let payload: z.infer<typeof StreamEventSchema>;
          try {
            payload = StreamEventSchema.parse(JSON.parse(frame.data));
          } catch {
            payload = {};
          }
          const type = payload.type ?? frame.event;
          if (type === 'image_generation.partial_succeeded') {
            const image = toImage(payload);
            accept(image);
            await options.onPartial?.(image);
          } else if (type === 'image_generation.completed') {
            usage = toUsage(payload.usage);
            completed = true;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const images = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, image]) => image)
    .concat(ordered);

  if (topError) throw topError;
  if (images.length === 0) {
    throw new SeedreamError(500, completed ? '图片生成已结束，但没有返回任何图片' : '流式连接中断，未收到图片');
  }
  return { model, created, images, usage, streamed: true };
}

/* ---------------- 公开 API ---------------- */

export async function generateSeedreamImages(
  request: SeedreamRequest,
  options: SeedreamOptions,
): Promise<SeedreamResponse> {
  if (!options.apiKey.trim()) throw new SeedreamError(401, '缺少火山引擎 API Key');
  const response = await post(request, options);
  if (!response.ok) {
    const text = await readErrorBody(response);
    const detail = parseError(text);
    throw new SeedreamError(response.status, detail.message, detail.code);
  }
  if (!request.stream) return readNonStream(response, request.model);

  const contentType = response.headers.get('content-type') ?? '';
  // 网关忽略 stream 时仍可能返回普通 JSON；兼容成非流式。
  if (contentType.includes('application/json')) return readNonStream(response, request.model);
  return readStream(response, request, options);
}

/** 把任意错误翻成一句中文原因（用户可读；vendor 原文放 message 备查） */
export function seedreamReason(error: unknown): string {
  if (error instanceof SeedreamError) {
    const code = error.code ?? '';
    if (code === 'AuthenticationError') return '火山引擎 API Key 无效或未授权，请到设置页检查';
    if (code === 'ModelNotFound') return `模型不存在或未开通：${error.message}`;
    if (code === 'InvalidEndpointOrModel.NotFound') return `模型不存在或未开通：${error.message}（不要自动换模型重试）`;
    if (code === 'SetLimitExceeded') {
      return '火山引擎账户触发了安全体验模式的用量上限（SetLimitExceeded）：请到方舟控制台调整/关闭该限额，不要自动换模型重试';
    }
    if (code === 'InvalidParameter') return `请求参数不合法：${error.message}`;
    if (code === 'QuotaExceeded') return '火山引擎额度不足或账户欠费，请检查账户';
    if (code === 'RateLimitExceeded') return '触发火山引擎限流，请稍后重试（不要自动换模型重试）';
    if (code === 'InternalServiceError') return '火山引擎服务内部错误，请稍后重试';
    if (code === 'OutputImageSensitiveContentDetected') return '输出图片疑似含敏感内容，被内容审核拦截';
    if (code === 'InputImageSensitiveContentDetected') return '输入图片疑似含敏感内容，被内容审核拦截';
    switch (error.status) {
      case 0:
        return error.message;
      case 400:
        return `请求不合法：${error.message}`;
      case 401:
        return '火山引擎 API Key 无效或缺失，请到设置页检查';
      case 403:
        return `火山引擎拒绝访问：${error.message || '请确认模型已开通且有权限'}`;
      case 404:
        return `接口或模型不存在（HTTP 404）：${error.message}`;
      case 429:
        return '触发火山引擎限流/用量上限，请稍后重试（不要自动换模型重试）';
      case 500:
      case 502:
      case 503:
      case 504:
        return `火山引擎服务暂时不可用（HTTP ${error.status}），请稍后重试`;
      default:
        return `火山引擎返回 HTTP ${error.status}${error.message ? `：${error.message}` : ''}`;
    }
  }
  if (error instanceof z.ZodError) return '火山引擎返回格式异常，无法解析';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '生成超时（火山引擎未在时限内返回）';
    if (error.name === 'AbortError') return '请求已取消';
    return `调用图片生成失败：${error.message}`;
  }
  return String(error);
}
