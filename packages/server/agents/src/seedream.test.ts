import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSeedreamExtension, type SeedreamToolOptions } from './seedream';

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: unknown) => void,
    ctx?: unknown,
  ) => Promise<{
    content: { type: string; text: string }[];
    details: {
      images?: { path: string; alt: string; size?: string }[];
      uploads?: { sha256: string; fileId: string; bytes: number; expiresAt: number | null }[];
      [key: string]: unknown;
    };
  }>;
}

interface Call {
  url: string;
  method: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const requestInit = init ?? {};
    const method = (requestInit.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> = {};
    if (typeof requestInit.body === 'string') {
      try {
        body = JSON.parse(requestInit.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    calls.push({ url, method, init: requestInit, body });
    const response = handler(url, requestInit);
    if (!response) throw new Error(`没有为 ${method} ${url} 预置响应`);
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bytesResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const DEFAULT_OPTIONS: Omit<SeedreamToolOptions, 'artifactDir' | 'fetchImpl'> = {
  baseUrl: 'https://ark.example/api/v3',
  apiKey: 'sk-ark-test',
  model: 'doubao-seedream-5-0-flash-260915',
};

function register(fetchImpl: typeof fetch, overrides: Partial<SeedreamToolOptions> = {}) {
  return {
    create(currentDir: string): RegisteredTool {
      const tools: RegisteredTool[] = [];
      const factory = createSeedreamExtension({
        ...DEFAULT_OPTIONS,
        artifactDir: currentDir,
        fetchImpl,
        ...overrides,
      });
      factory({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as unknown as ExtensionAPI);
      return tools[0]!;
    },
  };
}

function image(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { url, size: '2048x2048', output_format: 'jpeg', ...extra };
}

function imageResponse(data: Record<string, unknown>[]): Response {
  return jsonResponse({ model: 'doubao-seedream-5-0-flash-260915', created: 1, data, usage: { generated_images: data.length } });
}

/** Files API 上传/详情响应；图片场景直接 active */
function fileResponse(id: string): Response {
  return jsonResponse({
    object: 'file',
    id,
    purpose: 'user_data',
    filename: 'hash',
    bytes: 68,
    mime_type: 'image/png',
    created_at: Math.floor(Date.now() / 1000),
    expire_at: Math.floor(Date.now() / 1000) + 86_700,
    status: 'active',
  });
}

function formOf(call: Call): FormData {
  return call.init.body as FormData;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidocs-seedream-tool-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('seedream_image_generation 工具', () => {
  it('使用设置里的默认尺寸；工具参数 size 可覆盖', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([image('https://img.example/size.jpg')]);
      }
      if (method === 'GET' && url === 'https://img.example/size.jpg') return bytesResponse(JPEG);
      return undefined;
    });
    const tool = register(fetchImpl, { size: '1536x1024' }).create(dir);
    await tool.execute('t1', { prompt: '插图' });
    expect(calls.find((call) => call.method === 'POST')!.body.size).toBe('1536x1024');

    await tool.execute('t2', { prompt: '横幅', size: '2048x1152' });
    expect(calls.filter((call) => call.method === 'POST')[1]!.body.size).toBe('2048x1152');
  });

  it('默认尺寸不适用于当前模型时给出明确错误', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([image('https://img.example/x.jpg')]));
    await expect(
      register(fetchImpl, { size: '1536x1024', model: 'doubao-seedream-4-5-251128' })
        .create(dir)
        .execute('t1', { prompt: '插图' }),
    ).rejects.toThrow('默认尺寸');
    expect(calls).toHaveLength(0);
  });

  it('只注册一个工具，文生图默认 flash、无水印、保存 jpeg 并返回相对 Markdown 引用', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([image('https://img.example/1.jpg')]);
      }
      if (method === 'GET' && url === 'https://img.example/1.jpg') return bytesResponse(JPEG);
      return undefined;
    });
    const registered = register(fetchImpl).create(dir);
    expect(registered.name).toBe('seedream_image_generation');
    expect(registered.description).toContain('图层拆分');
    expect(registered.promptGuidelines?.join('\n')).toContain('插入 MAIN.md');

    const result = await registered.execute('t1', { prompt: '一只猫' });
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({
      model: 'doubao-seedream-5-0-flash-260915',
      prompt: '一只猫',
      output_format: 'jpeg',
      response_format: 'url',
      watermark: false,
    });
    expect(post.body.image).toBeUndefined();
    expect(post.body.stream).toBeUndefined();

    expect(readdirSync(join(dir, 'assets/images'))).toEqual(['一只猫.jpg']);
    const text = result.content[0]!.text;
    expect(text).toContain('![一只猫](assets/images/一只猫.jpg)');
    expect(text).not.toContain('http://localhost');
    expect(result.details.images).toEqual([
      { path: 'assets/images/一只猫.jpg', alt: '一只猫', size: '2048x2048' },
    ]);
  });

  it('显式 watermark:true 才向 Ark 发送水印', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return imageResponse([image('https://img.example/w.jpg')]);
      if (url.includes('img.example')) return bytesResponse(JPEG);
      return undefined;
    });
    await register(fetchImpl).create(dir).execute('t1', { prompt: '水印图', watermark: true });
    expect(calls.find((call) => call.method === 'POST')!.body.watermark).toBe(true);
  });

  it('本地参考图先上传方舟 Files API（文件名=SHA-256，1 天过期），Ark 收到 File ID；重复引用命中缓存', async () => {
    mkdirSync(join(dir, 'assets/images'), { recursive: true });
    const ref = Buffer.from('fake-reference-png');
    writeFileSync(join(dir, 'assets/images/ref.png'), ref);
    const hash = createHash('sha256').update(ref).digest('hex');

    let uploads = 0;
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/files')) {
        uploads += 1;
        return fileResponse(`file-${uploads}`);
      }
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([image(`https://img.example/${uploads}.jpg`)]);
      }
      if (method === 'GET' && url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    const registered = register(fetchImpl).create(dir);

    const first = await registered.execute('t1', {
      prompt: '改图',
      mode: 'image',
      images: ['assets/images/ref.png'],
    });
    expect(uploads).toBe(1);
    const form = formOf(calls.find((call) => call.method === 'POST' && call.url.endsWith('/files'))!);
    expect(form.get('purpose')).toBe('user_data');
    const expireAt = Number(form.get('expire_at'));
    const now = Math.floor(Date.now() / 1000);
    expect(expireAt).toBeGreaterThanOrEqual(now + 86_400);
    expect(expireAt).toBeLessThanOrEqual(now + 86_400 + 600);
    const file = form.get('file') as File;
    expect(file.name).toBe(hash);
    expect(file.type).toBe('image/png');

    const firstPost = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/images/generations'),
    )!;
    expect(firstPost.body.image).toBe('file-1');
    expect(String(firstPost.body.image)).not.toContain('base64');
    expect(first.content[0]!.text).toContain('参考图已上传方舟 Files API：1 张');
    expect(first.details.uploads?.[0]).toMatchObject({ sha256: hash, fileId: 'file-1' });
    expect(JSON.stringify(first.details)).not.toContain('download_url');

    await registered.execute('t2', { prompt: '再改', mode: 'image', images: ['assets/images/ref.png'] });
    expect(uploads).toBe(1);
    const secondPost = calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/images/generations'),
    )[1]!;
    expect(secondPost.body.image).toBe('file-1');
  });

  it('File ID 被生图接口拒绝时自动回退 base64 参考图', async () => {
    mkdirSync(join(dir, 'assets/images'), { recursive: true });
    writeFileSync(join(dir, 'assets/images/ref.png'), Buffer.from('fallback-reference'));
    let generations = 0;
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/files')) {
        return fileResponse('file-fallback');
      }
      if (method === 'POST' && url.endsWith('/images/generations')) {
        generations += 1;
        if (generations === 1) {
          return jsonResponse(
            {
              error: {
                code: 'InvalidParameter',
                message: 'The parameter `image` specified in the request is not valid',
              },
            },
            400,
          );
        }
        return imageResponse([image('https://img.example/fallback.jpg')]);
      }
      if (method === 'GET' && url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    const result = await register(fetchImpl).create(dir).execute('t1', {
      prompt: '按参考图生成',
      mode: 'image',
      images: ['assets/images/ref.png'],
    });
    expect(generations).toBe(2);
    const imageCalls = calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/images/generations'),
    );
    expect(imageCalls[0]!.body.image).toBe('file-fallback');
    expect(String(imageCalls[1]!.body.image)).toMatch(/^data:image\/png;base64,/);
    expect(result.content[0]!.text).toContain('回退为 base64');
    expect(result.details.images).toHaveLength(1);
  });

  it('本应用 /api/docs/.../assets/... 代理地址会还原成本地文件再上传 Files API', async () => {
    mkdirSync(join(dir, 'assets/images'), { recursive: true });
    const ref = Buffer.from('proxy-reference');
    writeFileSync(join(dir, 'assets/images/ref.png'), ref);
    const hash = createHash('sha256').update(ref).digest('hex');
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/files')) {
        return fileResponse('file-proxy');
      }
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([image('https://img.example/p.jpg')]);
      }
      if (method === 'GET' && url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    await register(fetchImpl).create(dir).execute('t1', {
      prompt: '代理图',
      mode: 'image',
      images: ['http://localhost:3084/api/docs/测试/文稿/assets/images/ref.png'],
    });
    const form = formOf(calls.find((call) => call.method === 'POST' && call.url.endsWith('/files'))!);
    expect((form.get('file') as File).name).toBe(hash);
    expect(
      calls.find((call) => call.method === 'POST' && call.url.endsWith('/images/generations'))!.body.image,
    ).toBe('file-proxy');
  });

  it('Files API 上传失败时回退 base64，仍调用 Ark 完成编辑', async () => {
    mkdirSync(join(dir, 'assets/images'), { recursive: true });
    writeFileSync(join(dir, 'assets/images/ref.png'), PNG);
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/files')) return new Response('not found', { status: 404 });
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([image('https://img.example/fallback-edit.jpg')]);
      }
      if (method === 'GET' && url === 'https://img.example/fallback-edit.jpg') return bytesResponse(JPEG);
      return undefined;
    });
    const result = await register(fetchImpl, { size: '1536x1024' }).create(dir).execute('t1', {
      prompt: '改',
      mode: 'image',
      images: ['assets/images/ref.png'],
    });
    const post = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/images/generations'),
    )!;
    expect(String(post.body.image)).toMatch(/^data:image\/png;base64,/);
    expect(post.body.size).toBeUndefined();
    expect(result.content[0]!.text).toContain('回退为 base64');
    expect(result.details.uploads).toHaveLength(0);
  });

  it('图层拆分：写底图+透明图层，保留 z_index/name/bbox，且只传 1 张参考图', async () => {
    mkdirSync(join(dir, 'assets/images'), { recursive: true });
    writeFileSync(join(dir, 'assets/images/ref.png'), Buffer.from('layer-ref'));
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/files')) {
        return fileResponse('file-layer');
      }
      if (method === 'POST' && url.endsWith('/images/generations')) {
        return imageResponse([
          { url: 'https://img.example/base.jpg', size: '2048x2048', output_format: 'jpeg', z_index: 0 },
          {
            url: 'https://img.example/layer.png',
            size: '800x200',
            output_format: 'png',
            z_index: 1,
            name: '标题',
            description: '标题文字',
            bounding_box: { absolute: [10, 20, 300, 100], normalized: [5, 10, 150, 50] },
          },
        ]);
      }
      if (method === 'GET' && url.endsWith('base.jpg')) return bytesResponse(JPEG);
      if (method === 'GET' && url.endsWith('layer.png')) return bytesResponse(PNG);
      return undefined;
    });
    const result = await register(fetchImpl).create(dir).execute('t1', {
      prompt: '拆图层',
      mode: 'layers',
      images: ['assets/images/ref.png'],
      title: '海报',
    });

    const post = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/images/generations'),
    )!;
    expect(post.body.layer_decomposition).toBe(true);
    expect(post.body.output_format).toBe('jpeg');
    expect(post.body.image).toBe('file-layer');
    const files = readdirSync(join(dir, 'assets/images'))
      .filter((name) => name.startsWith('海报-'))
      .sort();
    expect(files).toEqual(['海报-base.jpg', '海报-layer-1.png']);
    expect(result.content[0]!.text).toContain('图层「标题」');
    expect(result.content[0]!.text).toContain('bbox absolute');
    expect(result.details.images?.map((item) => item.path)).toEqual([
      'assets/images/海报-base.jpg',
      'assets/images/海报-layer-1.png',
    ]);
  });

  it('多图融合：Ark 收到 URL 数组，落盘按 -1/-2 编号', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        return imageResponse([image('https://img.example/f1.jpg'), image('https://img.example/f2.jpg')]);
      }
      if (method === 'GET' && url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    const result = await register(fetchImpl).create(dir).execute('t1', {
        prompt: '融合',
        mode: 'fusion',
        images: ['https://example.com/a.png', 'https://example.com/b.png'],
        title: '融合',
      });
    expect(calls.find((call) => call.method === 'POST')!.body.image).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
    expect(readdirSync(join(dir, 'assets/images')).sort()).toEqual(['融合-1.jpg', '融合-2.jpg']);
    expect(result.details.images).toHaveLength(2);
  });

  it('5.0 lite 组图 + 联网搜索：sequential/tools 字段正确，关闭流式时返回 JSON', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return imageResponse([image('https://img.example/g1.jpg'), image('https://img.example/g2.jpg')]);
      }
      if (url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    await register(fetchImpl).create(dir).execute('t1', {
      prompt: '组图',
      model: 'doubao-seedream-5-0-260128',
      images: ['https://example.com/ref.png'],
      max_images: 2,
      web_search: true,
      stream: false,
      title: '组图',
    });
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 2 },
      tools: [{ type: 'web_search' }],
      watermark: false,
    });
    expect(post.body.stream).toBeUndefined();
    expect(readdirSync(join(dir, 'assets/images')).sort()).toEqual(['组图-1.jpg', '组图-2.jpg']);
  });

  it('5.0 lite 流式：逐张 onUpdate，结束后照常落盘', async () => {
    const progress: string[] = [];
    const { calls, fetchImpl } = stubFetch((url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        return sseResponse([
          'event: image_generation.partial_succeeded\ndata: {"type":"image_generation.partial_succeeded","image_index":0,"url":"https://img.example/s1.jpg","size":"2048x2048"}\n\n',
          'event: image_generation.partial_succeeded\ndata: {"type":"image_generation.partial_succeeded","image_index":1,"url":"https://img.example/s2.jpg","size":"2048x2048"}\n\n',
          'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"generated_images":2}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      if (method === 'GET' && url.startsWith('https://img.example/')) return bytesResponse(JPEG);
      return undefined;
    });
    const result = await register(fetchImpl).create(dir).execute(
        't1',
        {
          prompt: '两张',
          model: 'doubao-seedream-5-0-260128',
          images: ['https://example.com/ref.png'],
          max_images: 2,
          title: '流式',
        },
        undefined,
        (partial) => {
          const text = (partial as { content: { text: string }[] }).content[0]?.text ?? '';
          progress.push(text);
        },
      );
    expect(calls.find((call) => call.method === 'POST')!.body.stream).toBe(true);
    expect(progress).toHaveLength(2);
    expect(progress[0]).toContain('已收到第 1 张');
    expect(result.details.images).toHaveLength(2);
    expect(readdirSync(join(dir, 'assets/images')).sort()).toEqual(['流式-1.jpg', '流式-2.jpg']);
  });

  it('默认 flash 不支持组图/流式/联网搜索时给出中文错误，且不发请求', async () => {
    const { calls, fetchImpl } = stubFetch(() => undefined);
    const registered = register(fetchImpl).create(dir);
    await expect(registered.execute('t1', { prompt: 'x', max_images: 2 })).rejects.toThrow('不支持组图');
    await expect(registered.execute('t2', { prompt: 'x', stream: true })).rejects.toThrow('流式');
    await expect(registered.execute('t3', { prompt: 'x', web_search: true })).rejects.toThrow('联网搜索');
    expect(calls).toHaveLength(0);
  });

  it('透明背景强制 png；显式 jpeg 报错', async () => {
    const { fetchImpl } = stubFetch(() => undefined);
    await expect(
      register(fetchImpl).create(dir).execute('t1', {
        prompt: '透明',
        mode: 'image',
        images: ['https://example.com/ref.png'],
        transparent: true,
        output_format: 'jpeg',
      }),
    ).rejects.toThrow('透明背景');
  });

  it('4.5 不发送 output_format（文档未列支持）', async () => {
    const { calls, fetchImpl } = stubFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return imageResponse([{ url: 'https://img.example/v45.png', size: '2048x2048' }]);
      if (url.includes('img.example')) return bytesResponse(PNG);
      return undefined;
    });
    const result = await register(fetchImpl).create(dir).execute('t1', {
        prompt: '4.5 图',
        model: 'doubao-seedream-4-5-251128',
        stream: false,
        title: 'v45',
      });
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body.output_format).toBeUndefined();
    expect(readdirSync(join(dir, 'assets/images'))).toEqual(['v45.png']);
    expect(result.details.images).toHaveLength(1);
  });

  it('尺寸/路径/参考图数量在发请求前校验', async () => {
    const { calls, fetchImpl } = stubFetch(() => undefined);
    const registered = register(fetchImpl).create(dir);
    await expect(registered.execute('t1', { prompt: 'x', size: '512x512' })).rejects.toThrow('总像素');
    await expect(
      registered.execute('t2', { prompt: 'x', mode: 'image', images: ['assets/../secret.png'] }),
    ).rejects.toThrow('路径不合法');
    await expect(
      registered.execute('t3', { prompt: 'x', mode: 'image', images: ['https://a.png', 'https://b.png'] }),
    ).rejects.toThrow('只能传 1 张');
    expect(calls).toHaveLength(0);
  });

  it('模式/提示词校验：文生图不传图、编辑必须传 1 张、非图层必须有 prompt', async () => {
    const { fetchImpl } = stubFetch(() => undefined);
    const registered = register(fetchImpl).create(dir);
    await expect(
      registered.execute('t1', { prompt: 'x', mode: 'text', images: ['https://a.png'] }),
    ).rejects.toThrow('文生图不要传参考图');
    await expect(registered.execute('t2', { mode: 'image' })).rejects.toThrow('只能传 1 张');
    await expect(registered.execute('t3', { mode: 'image', images: ['https://a.png'] })).rejects.toThrow('缺少 prompt');
    await expect(registered.execute('t4', { mode: 'text' })).rejects.toThrow('缺少 prompt');
  });
});
