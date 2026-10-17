import { createHash } from 'node:crypto';
import { arkApiUrl } from './ark';

/**
 * 火山方舟 Files API：
 * - `POST /files` 上传参考图（multipart，purpose=user_data，默认 1 天过期）；
 * - `GET /files/{id}` 轮询文件状态，直到 `active`；
 * - 返回 File ID，由生图工具直接作为 `image` 字段的值交给图片生成接口。
 *
 * 与生图共用同一个 Base URL / API Key；没有独立的临时存储配置。
 * 注意：Files API 的 detail/list 响应在当前线上并不返回 `download_url`，
 * 所以不使用预签名地址，而是使用 File ID。
 */

export class ArkFileError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ArkFileError';
    this.status = status;
    this.code = code;
  }
}

export interface ArkFileOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 上传后等待 processing → active 的轮询间隔 */
  pollIntervalMs?: number;
  /** 上传后等待 active 的总时长 */
  pollTimeoutMs?: number;
}

export interface ArkFileInfo {
  id: string;
  /** 本次上传内容的 SHA-256（详情响应不返回，由调用方补） */
  sha256: string | null;
  filename: string | null;
  bytes: number | null;
  mimeType: string | null;
  status: 'processing' | 'active' | 'failed';
  expireAt: number | null;
  error: { code: string; message: string } | null;
}

export interface UploadedArkFile extends ArkFileInfo {
  sha256: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
/** 1 天 + 5 分钟缓冲：API 要求 expire_at ≥ 服务端当前时刻 + 1 天 */
const EXPIRE_AFTER_SECONDS = 86_400 + 300;

export function arkFilesUrl(baseUrl: string): string {
  return arkApiUrl(baseUrl, '/files');
}

/** 文件内容 SHA-256，用于 Files API 的文件名（也供工具做上传缓存） */
export function contentHash(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function arkFileDetailUrl(baseUrl: string, id: string): string {
  return arkApiUrl(baseUrl, `/files/${encodeURIComponent(id)}`);
}

function requestSignal(options: ArkFileOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

function parseFile(raw: unknown, sha256: string | null = null): ArkFileInfo {
  const value = (raw ?? {}) as Record<string, unknown>;
  const error = value.error as { code?: unknown; message?: unknown } | undefined;
  const status = value.status === 'active' || value.status === 'failed' ? value.status : 'processing';
  return {
    id: typeof value.id === 'string' ? value.id : '',
    sha256,
    filename: typeof value.filename === 'string' ? value.filename : null,
    bytes: typeof value.bytes === 'number' ? value.bytes : null,
    mimeType: typeof value.mime_type === 'string' ? value.mime_type : null,
    status,
    expireAt: typeof value.expire_at === 'number' ? value.expire_at : null,
    error: error
      ? {
          code: typeof error.code === 'string' ? error.code : 'UnknownError',
          message: typeof error.message === 'string' ? error.message : '',
        }
      : null,
  };
}

function parseErrorBody(raw: string): { code?: string; message: string } {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    return {
      ...(parsed.error?.code ? { code: parsed.error.code } : {}),
      message: parsed.error?.message ?? parsed.error?.code ?? raw.slice(0, 300),
    };
  } catch {
    return { message: raw.slice(0, 300) };
  }
}

async function requestFile(
  method: 'GET' | 'POST',
  url: string,
  options: ArkFileOptions,
  form?: FormData,
): Promise<ArkFileInfo> {
  if (options.signal?.aborted) throw new ArkFileError(0, '请求已取消');
  if (!options.apiKey.trim()) throw new ArkFileError(401, '还没有保存 API Key');
  const fetchImpl = options.fetchImpl ?? fetch;
  // FormData 的 Content-Type 必须交给 fetch 生成 boundary，这里不能手写
  const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(form ? { body: form } : {}),
      signal: requestSignal(options),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ArkFileError(0, '请求已取消');
    if ((error as Error)?.name === 'TimeoutError') throw new ArkFileError(0, 'Files API 请求超时');
    throw new ArkFileError(0, `无法连接 Files API：${(error as Error)?.message ?? String(error)}`);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const detail = parseErrorBody(text);
    throw new ArkFileError(response.status, detail.message, detail.code);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ArkFileError(500, 'Files API 返回的不是合法 JSON', 'bad_schema');
  }
  return parseFile(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET /files/{id}：取文件详情（状态/过期时间） */
export async function getArkFile(id: string, options: ArkFileOptions): Promise<ArkFileInfo> {
  if (!id.trim()) throw new ArkFileError(400, '文件 ID 为空');
  const file = await requestFile('GET', arkFileDetailUrl(options.baseUrl, id), options);
  if (!file.id) file.id = id;
  if (file.status === 'failed') {
    throw new ArkFileError(400, file.error?.message ?? 'Files API 文件处理失败', file.error?.code);
  }
  return file;
}

/** POST /files：上传参考图；默认 1 天过期；对象名 = 内容 SHA-256 */
export async function uploadArkFile(
  bytes: Buffer,
  contentType: string,
  options: ArkFileOptions,
): Promise<UploadedArkFile> {
  if (bytes.length === 0) throw new ArkFileError(400, '参考图内容为空');
  if (!/^image\//i.test(contentType)) throw new ArkFileError(400, `不支持的图片类型：${contentType}`);
  const sha256 = contentHash(bytes);
  const form = new FormData();
  form.set('purpose', 'user_data');
  form.set('expire_at', String(Math.floor(Date.now() / 1000) + EXPIRE_AFTER_SECONDS));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), sha256);

  const uploaded = await requestFile('POST', arkFilesUrl(options.baseUrl), options, form);
  uploaded.sha256 = sha256;
  if (!uploaded.id) throw new ArkFileError(500, 'Files API 没有返回文件 ID', 'missing_file_id');
  if (uploaded.status === 'failed') {
    throw new ArkFileError(400, uploaded.error?.message ?? 'Files API 文件上传失败', uploaded.error?.code);
  }
  if (uploaded.status === 'active') return uploaded as UploadedArkFile;

  const deadline = Date.now() + (options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const file = await getArkFile(uploaded.id, options);
    if (file.status === 'active') {
      return { ...file, sha256 };
    }
  }
  throw new ArkFileError(500, 'Files API 文件处理超时（未在时限内 active）', 'processing_timeout');
}

/** 把 Files API 错误翻成一句中文原因 */
export function arkFilesReason(error: unknown): string {
  if (error instanceof ArkFileError) {
    switch (error.status) {
      case 0:
        return error.message;
      case 401:
        return '火山引擎 API Key 无效或缺失，Files API 无法上传';
      case 403:
        return `Files API 拒绝访问：${error.message || '请确认 Key 有权限'}`;
      case 404:
        return 'Files API 接口或文件不存在（HTTP 404）：确认 Base URL 是否为 /api/v3；/api/plan 路径可能不支持 Files API';
      case 413:
        return '参考图超过 Files API 的大小限制';
      case 429:
        return 'Files API 触发限流，请稍后重试';
      case 500:
      case 502:
      case 503:
      case 504:
        return `Files API 服务暂时不可用（HTTP ${error.status}），请稍后重试`;
      default:
        return `Files API 返回 HTTP ${error.status}${error.message ? `：${error.message}` : ''}`;
    }
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'Files API 请求超时';
    if (error.name === 'AbortError') return '请求已取消';
    return `Files API 上传失败：${error.message}`;
  }
  return String(error);
}
