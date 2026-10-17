import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ArkFileError,
  arkFileDetailUrl,
  arkFilesReason,
  arkFilesUrl,
  getArkFile,
  uploadArkFile,
} from './ark-files';
import { arkApiBase } from './ark';

interface Call {
  url: string;
  init: RequestInit;
  method: string;
  form?: FormData;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const requestInit = init ?? {};
    const method = (requestInit.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      init: requestInit,
      method,
      ...(requestInit.body instanceof FormData ? { form: requestInit.body } : {}),
    });
    const response = handler(url, requestInit);
    if (!response) throw new Error(`没有为 ${method} ${url} 预置响应`);
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const BYTES = Buffer.from('seedream-reference-bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function fileBody(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'file',
    id,
    purpose: 'user_data',
    filename: SHA,
    bytes: BYTES.length,
    mime_type: 'image/png',
    created_at: 1,
    expire_at: Math.floor(Date.now() / 1000) + 86_700,
    status: 'active',
    ...extra,
  };
}

describe('ark 公共地址', () => {
  it('只填域名补 /api/v3；已带路径保持；拒绝 query/hash', () => {
    expect(arkApiBase('https://ark.example.com')).toBe('https://ark.example.com/api/v3');
    expect(arkApiBase('https://ark.example.com/api/v3/')).toBe('https://ark.example.com/api/v3');
    expect(arkApiBase('https://ark.example.com/proxy')).toBe('https://ark.example.com/proxy');
    expect(arkFilesUrl('https://ark.example.com')).toBe('https://ark.example.com/api/v3/files');
    expect(arkFileDetailUrl('https://ark.example.com', 'file-1')).toBe(
      'https://ark.example.com/api/v3/files/file-1',
    );
    expect(() => arkApiBase('https://ark.example.com?x=1')).toThrow('查询串');
    expect(() => arkApiBase('ftp://ark.example.com')).toThrow('http/https');
  });
});

describe('uploadArkFile', () => {
  it('multipart 上传：purpose=user_data、1 天有效期、文件名=内容 SHA-256、不手写 Content-Type', async () => {
    const { calls, fetchImpl } = stubFetch(() => json(fileBody('file-1')));
    const file = await uploadArkFile(BYTES, 'image/png', {
      baseUrl: 'https://ark.example.com/api/v3',
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(file.id).toBe('file-1');
    expect(file.sha256).toBe(SHA);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://ark.example.com/api/v3/files');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['content-type']).toBeUndefined();
    const form = call.form!;
    expect(form.get('purpose')).toBe('user_data');
    const expireAt = Number(form.get('expire_at'));
    const now = Math.floor(Date.now() / 1000);
    expect(expireAt).toBeGreaterThanOrEqual(now + 86_400);
    expect(expireAt).toBeLessThanOrEqual(now + 86_400 + 600);
    const blob = form.get('file') as File;
    expect(blob.name).toBe(SHA);
    expect(blob.type).toBe('image/png');
  });

  it('processing 时轮询详情直到 active', async () => {
    let details = 0;
    const { calls, fetchImpl } = stubFetch((_url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST') return json(fileBody('file-2', { status: 'processing' }));
      details += 1;
      return json(fileBody('file-2'));
    });
    const file = await uploadArkFile(BYTES, 'image/png', {
      baseUrl: 'https://ark.example.com',
      apiKey: 'sk-test',
      fetchImpl,
      pollIntervalMs: 0,
    });
    expect(details).toBe(1);
    expect(file.status).toBe('active');
    expect(file.id).toBe('file-2');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('status=failed 时抛错', async () => {
    const failed = stubFetch(() =>
      json(fileBody('file-3', { status: 'failed', error: { code: 'BadFile', message: 'bad file' } })),
    );
    await expect(
      uploadArkFile(BYTES, 'image/png', {
        baseUrl: 'https://ark.example.com',
        apiKey: 'sk-test',
        fetchImpl: failed.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ArkFileError);
  });

  it('HTTP 403/413/429 翻成中文原因', async () => {
    for (const [status, expected] of [
      [403, 'Files API'],
      [413, '大小限制'],
      [429, '限流'],
    ] as const) {
      const { fetchImpl } = stubFetch(() => new Response('denied', { status }));
      try {
        await uploadArkFile(BYTES, 'image/png', {
          baseUrl: 'https://ark.example.com',
          apiKey: 'sk-test',
          fetchImpl,
        });
      } catch (error) {
        expect(arkFilesReason(error)).toContain(expected);
      }
    }
  });
});

describe('getArkFile', () => {
  it('404 翻成文件不存在/已过期', async () => {
    const { fetchImpl } = stubFetch(() => new Response('not found', { status: 404 }));
    try {
      await getArkFile('file-missing', { baseUrl: 'https://ark.example.com', apiKey: 'sk-test', fetchImpl });
    } catch (error) {
      expect(arkFilesReason(error)).toContain('不存在');
    }
  });
});
