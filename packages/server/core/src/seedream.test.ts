import { describe, expect, it } from 'vitest';
import {
  SeedreamError,
  generateSeedreamImages,
  seedreamImagesUrl,
  seedreamReason,
  type SeedreamRequest,
} from './seedream';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function stubFetch(response: Response | ((url: string, init: RequestInit) => Response)) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit, body: JSON.parse(String(requestInit.body ?? '{}')) as Record<string, unknown> });
    return typeof response === 'function' ? response(url, requestInit) : response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

const BASE = 'https://ark.example.com/api/v3';

describe('seedreamImagesUrl', () => {
  it('只填域名补 /api/v3；已带路径直接拼；拒绝 query/hash', () => {
    expect(seedreamImagesUrl('https://ark.cn-beijing.volces.com')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
    expect(seedreamImagesUrl('https://ark.cn-beijing.volces.com/api/v3/')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    );
    expect(() => seedreamImagesUrl('https://host/api/v3?x=1')).toThrow(SeedreamError);
    expect(() => seedreamImagesUrl('ftp://host')).toThrow(SeedreamError);
  });
});

describe('generateSeedreamImages 非流式', () => {
  it('按请求字段提交，解析 data/usage', async () => {
    const { calls, fetchImpl } = stubFetch(
      jsonResponse({
        model: 'doubao-seedream-5-0-flash-260915',
        created: 123,
        data: [{ url: 'https://img.example.com/1.jpg', size: '2048x2048', output_format: 'jpeg' }],
        usage: { generated_images: 1, output_tokens: 100, total_tokens: 100, input_images: 1 },
      }),
    );
    const request: SeedreamRequest = {
      model: 'doubao-seedream-5-0-flash-260915',
      prompt: '一只猫',
      image: 'https://tmp.example.com/hash',
      size: '2K',
      output_format: 'jpeg',
      response_format: 'url',
      watermark: false,
    };
    const result = await generateSeedreamImages(request, { baseUrl: BASE, apiKey: 'sk-test', fetchImpl });

    expect(calls[0]?.url).toBe(`${BASE}/images/generations`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(calls[0]?.body).toEqual(request);
    expect(result.streamed).toBe(false);
    expect(result.model).toBe('doubao-seedream-5-0-flash-260915');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      url: 'https://img.example.com/1.jpg',
      size: '2048x2048',
      outputFormat: 'jpeg',
    });
    expect(result.usage).toEqual({
      generatedImages: 1,
      inputImages: 1,
      outputTokens: 100,
      totalTokens: 100,
      webSearch: null,
    });
  });

  it('HTTP 401 抛 SeedreamError，并翻成中文原因', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({ error: { code: 'AuthenticationError', message: 'invalid key' } }, 401),
    );
    await expect(
      generateSeedreamImages({ model: 'm', prompt: 'p' }, { baseUrl: BASE, apiKey: 'bad', fetchImpl }),
    ).rejects.toMatchObject({ status: 401, code: 'AuthenticationError' });
    try {
      await generateSeedreamImages({ model: 'm', prompt: 'p' }, { baseUrl: BASE, apiKey: 'bad', fetchImpl });
    } catch (error) {
      expect(seedreamReason(error)).toContain('API Key');
    }
  });

  it('data 里的单图错误保留在 images[].error', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        data: [{ error: { code: 'OutputImageSensitiveContentDetected', message: 'blocked' }, size: '2048x2048' }],
      }),
    );
    const result = await generateSeedreamImages({ model: 'm', prompt: 'p' }, { baseUrl: BASE, apiKey: 'k', fetchImpl });
    expect(result.images[0]?.error).toEqual({ code: 'OutputImageSensitiveContentDetected', message: 'blocked' });
  });

  it('b64_json 也能解析', async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ data: [{ b64_json: 'aGVsbG8=', size: '1024x1024' }] }));
    const result = await generateSeedreamImages({ model: 'm', prompt: 'p' }, { baseUrl: BASE, apiKey: 'k', fetchImpl });
    expect(result.images[0]?.b64).toBe('aGVsbG8=');
  });
});

describe('generateSeedreamImages 流式', () => {
  it('逐帧回调 partial_succeeded，按 image_index 排序，completed 带 usage', async () => {
    const partials: number[] = [];
    const { fetchImpl } = stubFetch(
      sseResponse([
        'event: image_generation.partial_succeeded\ndata: {"type":"image_generation.partial_succeeded","model":"m","image_index":1,"url":"https://img/2.jpg","size":"2048x2048"}\n\n',
        'event: image_generation.partial_succeeded\ndata: {"type":"image_generation.partial_succeeded","model":"m","image_index":0,"url":"https://img/1.jpg","size":"2048x2048"}\n\n',
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"generated_images":2,"output_tokens":200,"total_tokens":200,"tool_usage":{"web_search":1}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const result = await generateSeedreamImages(
      { model: 'm', prompt: 'p', stream: true, tools: [{ type: 'web_search' }] },
      {
        baseUrl: BASE,
        apiKey: 'k',
        fetchImpl,
        onPartial: (image) => {
          partials.push(image.imageIndex ?? -1);
        },
      },
    );
    expect(partials).toEqual([1, 0]);
    expect(result.streamed).toBe(true);
    expect(result.images.map((image) => image.imageIndex)).toEqual([0, 1]);
    expect(result.images.map((image) => image.url)).toEqual(['https://img/1.jpg', 'https://img/2.jpg']);
    expect(result.usage.generatedImages).toBe(2);
    expect(result.usage.webSearch).toBe(1);
  });

  it('partial_failed 收集单图错误，继续接收成功图', async () => {
    const { fetchImpl } = stubFetch(
      sseResponse([
        'event: image_generation.partial_failed\ndata: {"type":"image_generation.partial_failed","image_index":1,"error":{"code":"OutputImageSensitiveContentDetected","message":"blocked"}}\n\n',
        'event: image_generation.partial_succeeded\ndata: {"type":"image_generation.partial_succeeded","image_index":0,"url":"https://img/1.jpg"}\n\n',
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"generated_images":1}}\n\n',
      ]),
    );
    const result = await generateSeedreamImages(
      { model: 'm', prompt: 'p', stream: true },
      { baseUrl: BASE, apiKey: 'k', fetchImpl },
    );
    expect(result.images).toHaveLength(2);
    expect(result.images.find((image) => image.imageIndex === 1)?.error?.code).toBe(
      'OutputImageSensitiveContentDetected',
    );
  });

  it('顶层 error 事件直接抛错', async () => {
    const { fetchImpl } = stubFetch(
      sseResponse([
        'event: error\ndata: {"error":{"code":"AuthenticationError","message":"bad key"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    await expect(
      generateSeedreamImages({ model: 'm', prompt: 'p', stream: true }, { baseUrl: BASE, apiKey: 'k', fetchImpl }),
    ).rejects.toMatchObject({ code: 'AuthenticationError' });
  });

  it('网关忽略 stream 返回 JSON 时按非流式处理', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({ data: [{ url: 'https://img/1.jpg', output_format: 'png' }] }),
    );
    const result = await generateSeedreamImages(
      { model: 'm', prompt: 'p', stream: true },
      { baseUrl: BASE, apiKey: 'k', fetchImpl },
    );
    expect(result.streamed).toBe(false);
    expect(result.images[0]?.url).toBe('https://img/1.jpg');
  });
});
