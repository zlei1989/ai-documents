import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeDirSync } from '@aidocs/core';
import { DELETE as deleteProvider, GET as getProviders, POST as postProvider, PUT as putProvider } from '../app/api/providers/route';
import { POST as importModelsRoute } from '../app/api/providers/[id]/models/import/route';
import { DELETE as deleteModelRoute, PUT as saveModelRoute } from '../app/api/providers/[id]/models/route';
import { POST as testProviderRoute } from '../app/api/providers/[id]/test/route';
import { GET as getSettings, PUT as putSettings } from '../app/api/settings/route';
import { POST as initStorage } from '../app/api/storage/init/route';
import { GET as getRepair, POST as postRepair } from '../app/api/storage/repair/route';
import { POST as syncStorageRoute } from '../app/api/storage/sync/route';
import { POST as createDoc, GET as listDocs } from '../app/api/docs/route';
import { DELETE as deleteDoc, PUT as putDoc } from '../app/api/docs/[group]/[name]/route';
import { GET as getMcp, POST as postMcp, DELETE as deleteMcp } from '../app/api/mcp/route';
import { POST as probeMcp } from '../app/api/mcp/probe/route';
import { GET as getSkills } from '../app/api/skills/route';
import { PUT as toggleSkill } from '../app/api/skills/toggle/route';
import { GET as skillContent } from '../app/api/skills/content/route';
import { POST as testResearchRoute } from '../app/api/research/test/route';
import { GET as researchSources } from '../app/api/research/sources/route';
import { GET as getSeedream, PUT as putSeedream } from '../app/api/seedream/route';
import { POST as testSeedreamRoute } from '../app/api/seedream/test/route';
import { isolateEnv, jsonRequest, readJson } from './helpers';

let env: ReturnType<typeof isolateEnv>;
let tmpRoot: string;

beforeEach(() => {
  env = isolateEnv();
  tmpRoot = mkdtempSync(join(tmpdir(), 'aidocs-routes-'));
});
afterEach(() => {
  env.restore();
  vi.unstubAllGlobals();
  removeDirSync(tmpRoot);
});

const providerInput = {
  name: '测试供应商',
  protocol: 'openai' as const,
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-secret-3a0f',
};

async function createProvider(): Promise<{ id: string }> {
  const res = await postProvider(jsonRequest('http://localhost/api/providers', providerInput));
  expect(res.status).toBe(201);
  return readJson<{ id: string }>(res);
}

describe('路由：供应商', () => {
  it('GET 列表 / POST 创建（掩码）', async () => {
    const empty = await getProviders(new Request('http://localhost/api/providers'));
    expect(empty.status).toBe(200);
    expect(await readJson(empty)).toEqual([]);

    const created = await createProvider();
    expect(created.id).toBeTruthy();

    const list = await readJson<Array<{ apiKey: string }>>(await getProviders(new Request('http://localhost/api/providers')));
    expect(list).toHaveLength(1);
    expect(list[0]?.apiKey).toBe('sk-…3a0f');
    expect(JSON.stringify(list)).not.toContain('sk-secret-3a0f');
  });

  it('参数不合法返回 400 + 中文错误', async () => {
    const res = await postProvider(jsonRequest('http://localhost/api/providers', { name: '' }));
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain('请求参数不合法');
  });

  it('PUT 缺 id 返回 400；DELETE 缺 id 返回 400、未知 id 返回 404', async () => {
    expect((await putProvider(jsonRequest('http://localhost/api/providers', providerInput, 'PUT'))).status).toBe(400);
    expect((await deleteProvider(new Request('http://localhost/api/providers', { method: 'DELETE' }))).status).toBe(400);

    const missing = await deleteProvider(new Request('http://localhost/api/providers?id=missing', { method: 'DELETE' }));
    expect(missing.status).toBe(404);

    const created = await createProvider();
    const deleted = await deleteProvider(new Request(`http://localhost/api/providers?id=${created.id}`, { method: 'DELETE' }));
    expect(deleted.status).toBe(200);
    expect(await readJson(await getProviders(new Request('http://localhost/api/providers')))).toEqual([]);
  });

  it('导入模型路由走服务层校验', async () => {
    const provider = await createProvider();
    const res = await importModelsRoute(
      jsonRequest(`http://localhost/api/providers/${provider.id}/models/import`, { models: [{ id: 'm1' }] }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    expect(res.status).toBe(200);
    expect((await readJson<{ models: Array<{ id: string }> }>(res)).models.map((m) => m.id)).toEqual(['m1']);

    const empty = await importModelsRoute(
      jsonRequest(`http://localhost/api/providers/${provider.id}/models/import`, { models: [] }),
      { params: Promise.resolve({ id: provider.id }) },
    );
    expect(empty.status).toBe(400);
  });

  it('手动保存/删除模型路由：新增替换、参数校验、默认引用保护', async () => {
    const provider = await createProvider();
    const url = `http://localhost/api/providers/${provider.id}/models`;
    const context = { params: Promise.resolve({ id: provider.id }) };

    const saved = await saveModelRoute(
      jsonRequest(
        url,
        { id: 'vision', contextWindow: 200_000, maxOutputTokens: 8_192, supportsImages: true },
        'PUT',
      ),
      context,
    );
    expect(saved.status).toBe(200);
    expect((await readJson<{ models: Array<Record<string, unknown>> }>(saved)).models).toEqual([
      { id: 'vision', contextWindow: 200_000, maxOutputTokens: 8_192, supportsImages: true },
    ]);

    const replaced = await saveModelRoute(
      jsonRequest(url, { id: 'vision', supportsImages: false }, 'PUT'),
      context,
    );
    expect(replaced.status).toBe(200);
    expect((await readJson<{ models: Array<Record<string, unknown>> }>(replaced)).models).toEqual([
      { id: 'vision', supportsImages: false },
    ]);

    const invalid = await saveModelRoute(jsonRequest(url, { id: '' }, 'PUT'), context);
    expect(invalid.status).toBe(400);
    const missingProvider = await saveModelRoute(jsonRequest(url, { id: 'x' }, 'PUT'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(missingProvider.status).toBe(404);

    const setDefault = await putSettings(
      jsonRequest('http://localhost/api/settings', { defaultModel: `${provider.id}/vision` }, 'PUT'),
    );
    expect(setDefault.status).toBe(200);
    const conflict = await deleteModelRoute(new Request(`${url}?modelId=vision`, { method: 'DELETE' }), context);
    expect(conflict.status).toBe(409);
    await putSettings(jsonRequest('http://localhost/api/settings', { defaultModel: null }, 'PUT'));

    const missingParam = await deleteModelRoute(new Request(url, { method: 'DELETE' }), context);
    expect(missingParam.status).toBe(400);
    const unknown = await deleteModelRoute(new Request(`${url}?modelId=missing`, { method: 'DELETE' }), context);
    expect(unknown.status).toBe(404);
    const deleted = await deleteModelRoute(new Request(`${url}?modelId=vision`, { method: 'DELETE' }), context);
    expect(deleted.status).toBe(200);
    expect((await readJson<{ models: Array<Record<string, unknown>> }>(deleted)).models).toEqual([]);
  });

  it('测试调用路由：无模型 400、未知供应商 404', async () => {
    const provider = await createProvider();
    const noModel = await testProviderRoute(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ id: provider.id }),
    });
    expect(noModel.status).toBe(400);

    const missing = await testProviderRoute(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('路由：设置与存储', () => {
  it('GET 返回设置 + git 状态，PUT 改自动提交并落盘', async () => {
    const initial = await readJson<{ settings: { autoCommit: boolean }; storage: { git: { isRepo: boolean } } }>(
      await getSettings(new Request('http://localhost/api/settings')),
    );
    expect(initial.settings.autoCommit).toBe(true);
    expect(initial.storage.git.isRepo).toBe(false);

    const res = await putSettings(jsonRequest('http://localhost/api/settings', { autoCommit: false }, 'PUT'));
    expect(res.status).toBe(200);
    expect((await readJson<{ settings: { autoCommit: boolean } }>(res)).settings.autoCommit).toBe(false);
  });

  it('PUT thinkingLevel 落盘为四档之一；其它档位 400', async () => {
    const initial = await readJson<{ settings: { thinkingLevel: string } }>(
      await getSettings(new Request('http://localhost/api/settings')),
    );
    expect(initial.settings.thinkingLevel).toBe('off');

    const ok = await putSettings(jsonRequest('http://localhost/api/settings', { thinkingLevel: 'high' }, 'PUT'));
    expect(ok.status).toBe(200);
    expect((await readJson<{ settings: { thinkingLevel: string } }>(ok)).settings.thinkingLevel).toBe('high');

    const bad = await putSettings(jsonRequest('http://localhost/api/settings', { thinkingLevel: 'max' }, 'PUT'));
    expect(bad.status).toBe(400);
    expect((await readJson<{ error: string }>(bad)).error).toContain('thinkingLevel');
  });

  it('PUT storageRoot 走校验；相对路径 400，绝对路径不再限制位置', async () => {
    const target = join(tmpRoot, '我的文档');
    const ok = await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: target }, 'PUT'));
    expect(ok.status).toBe(200);
    expect((await readJson<{ storage: { storageRoot: string } }>(ok)).storage.storageRoot).toBe(target);

    const bad = await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: 'relative/dir' }, 'PUT'));
    expect(bad.status).toBe(400);
    expect((await readJson<{ error: string }>(bad)).error).toContain('绝对路径');
  });

  it('POST /api/storage/init 初始化 git，重复调用幂等', async () => {
    await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: join(tmpRoot, 'docs') }, 'PUT'));

    const initRequest = () => new Request('http://localhost/api/storage/init', { method: 'POST' });
    const first = await initStorage(initRequest());
    expect(first.status).toBe(200);
    const state = await readJson<{ git: { isRepo: boolean; branch: string | null } }>(first);
    expect(state.git.isRepo).toBe(true);
    expect(state.git.branch).toBe('main');

    expect((await initStorage(initRequest())).status).toBe(200);
  });

  it('同步路由：参数与仓库校验；repair 路由缺 id / 未知 id', async () => {
    const bad = await syncStorageRoute(jsonRequest('http://localhost/api/storage/sync', { action: 'fetch' }));
    expect(bad.status).toBe(400);

    await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: join(tmpRoot, 'norepo') }, 'PUT'));
    const noRepo = await syncStorageRoute(jsonRequest('http://localhost/api/storage/sync', { action: 'pull' }));
    expect(noRepo.status).toBe(400);
    expect((await readJson<{ error: string }>(noRepo)).error).toContain('不是 git 仓库');

    expect((await getRepair(new Request('http://localhost/api/storage/repair'))).status).toBe(400);
    expect((await getRepair(new Request('http://localhost/api/storage/repair?id=missing'))).status).toBe(404);

    const abortNoId = await postRepair(jsonRequest('http://localhost/api/storage/repair', { action: 'abort' }));
    expect(abortNoId.status).toBe(400);
    const abortMissing = await postRepair(
      jsonRequest('http://localhost/api/storage/repair', { action: 'abort', id: 'missing' }),
    );
    expect(abortMissing.status).toBe(404);
  });
});

describe('路由：文档', () => {
  const ctx = (group: string, name: string) => ({ params: Promise.resolve({ group, name }) });

  beforeEach(async () => {
    const res = await putSettings(
      jsonRequest('http://localhost/api/settings', { storageRoot: join(tmpRoot, 'docs') }, 'PUT'),
    );
    expect(res.status).toBe(200);
  });

  it('创建 / 列表 / 重命名 / 删除', async () => {
    const created = await createDoc(
      jsonRequest('http://localhost/api/docs', { group: '产品', name: '旧名', type: '技术方案' }),
    );
    expect(created.status).toBe(200);
    expect(await readJson<{ name: string }>(created)).toMatchObject({ name: '旧名' });
    expect(await readJson<Array<{ name: string }>>(await listDocs())).toEqual([
      expect.objectContaining({ name: '旧名' }),
    ]);

    const renamed = await putDoc(
      jsonRequest('http://localhost/api/docs/产品/旧名', { name: '新名' }, 'PUT'),
      ctx('产品', '旧名'),
    );
    expect(renamed.status).toBe(200);
    expect(await readJson<{ name: string }>(renamed)).toMatchObject({ name: '新名' });
    expect(await readJson<Array<{ name: string }>>(await listDocs())).toEqual([
      expect.objectContaining({ name: '新名' }),
    ]);

    const removed = await deleteDoc(
      new Request('http://localhost/api/docs/产品/新名', { method: 'DELETE' }),
      ctx('产品', '新名'),
    );
    expect(removed.status).toBe(200);
    expect(await readJson<unknown[]>(await listDocs())).toEqual([]);
  });
});

describe('路由：MCP', () => {
  const stdio = { name: 'context7', transport: 'stdio' as const, command: 'node', args: [], env: {}, headers: {}, enabled: true };

  it('POST 单条 / 数组导入、GET 列表、DELETE', async () => {
    expect((await postMcp(jsonRequest('http://localhost/api/mcp', stdio))).status).toBe(201);
    expect(await readJson<unknown[]>(await getMcp(new Request('http://localhost/api/mcp')))).toHaveLength(1);

    const imported = await postMcp(
      jsonRequest('http://localhost/api/mcp', [stdio, { ...stdio, name: 'playwright', command: 'npx' }]),
    );
    expect(imported.status).toBe(201);
    expect(await readJson<unknown[]>(await getMcp(new Request('http://localhost/api/mcp')))).toHaveLength(2);

    const removed = await deleteMcp(new Request('http://localhost/api/mcp?name=context7', { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(await readJson<unknown[]>(await getMcp(new Request('http://localhost/api/mcp')))).toHaveLength(1);
  });

  it('非法 MCP 配置 400；未知删除 404', async () => {
    expect((await postMcp(jsonRequest('http://localhost/api/mcp', { name: 'x', transport: 'stdio' }))).status).toBe(400);
    expect((await deleteMcp(new Request('http://localhost/api/mcp?name=missing', { method: 'DELETE' }))).status).toBe(404);
  });

  it('POST 文本导入：VS Code 信封由服务端解析；clear 先清空', async () => {
    const text = JSON.stringify({
      servers: { playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
      inputs: [],
    });
    const res = await postMcp(jsonRequest('http://localhost/api/mcp', { text }));
    expect(res.status).toBe(201);
    const body = await readJson<{ imported: number; style: string; servers: Array<{ name: string }> }>(res);
    expect(body.imported).toBe(1);
    expect(body.style).toBe('servers');
    expect(body.servers.map((server) => server.name)).toEqual(['playwright']);

    const cleared = await postMcp(
      jsonRequest('http://localhost/api/mcp', { text: '{ "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }', clear: true }),
    );
    expect(cleared.status).toBe(201);
    expect((await readJson<{ servers: Array<{ name: string }> }>(cleared)).servers.map((server) => server.name)).toEqual([
      'context7',
    ]);
    expect(await readJson<unknown[]>(await getMcp(new Request('http://localhost/api/mcp')))).toHaveLength(1);
  });

  it('POST 文本导入：语法错 / 认不出 / 全被拒 400', async () => {
    expect((await postMcp(jsonRequest('http://localhost/api/mcp', { text: '{ "mcpServers": ' }))).status).toBe(400);
    expect((await postMcp(jsonRequest('http://localhost/api/mcp', { text: '{ "foo": 1 }' }))).status).toBe(400);
    expect(
      (await postMcp(jsonRequest('http://localhost/api/mcp', { text: '{ "mcpServers": { "x": { "type": "sdk" } } }' }))).status,
    ).toBe(400);
  });

  it('POST { servers, clear } 数组导入也能清空', async () => {
    await postMcp(jsonRequest('http://localhost/api/mcp', stdio));
    const res = await postMcp(
      jsonRequest('http://localhost/api/mcp', {
        servers: [{ ...stdio, name: 'only', command: 'npx' }],
        clear: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(await readJson<unknown[]>(await getMcp(new Request('http://localhost/api/mcp')))).toHaveLength(1);
  });

  it('探针：stdio 按名字或内联配置都能测', async () => {
    await postMcp(jsonRequest('http://localhost/api/mcp', stdio));
    const byName = await probeMcp(jsonRequest('http://localhost/api/mcp/probe', { name: 'context7' }));
    expect(byName.status).toBe(200);
    expect((await readJson<{ state: string }>(byName)).state).toBe('ok');

    const inline = await probeMcp(jsonRequest('http://localhost/api/mcp/probe', { server: stdio }));
    expect((await readJson<{ state: string }>(inline)).state).toBe('ok');

    expect((await probeMcp(jsonRequest('http://localhost/api/mcp/probe', { name: 'missing' }))).status).toBe(404);
  });

  it('探针：uvx 这类启动器缺安装时，失败原因里给的是安装方式', async () => {
    const res = await probeMcp(
      jsonRequest('http://localhost/api/mcp/probe', {
        server: { name: 'time', transport: 'stdio', command: 'definitely-missing-mcp-bin', args: [], env: {}, headers: {}, enabled: true },
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ state: string; reason: string }>(res);
    expect(body.state).toBe('error');
    expect(body.reason).toContain('找不到可执行命令');
  });

  it('POST 文本导入：uvx 启动的服务器按包名猜名字', async () => {
    const res = await postMcp(
      jsonRequest('http://localhost/api/mcp', {
        text: '{ "command": "uvx", "args": ["--from", "some-index", "mcp-server-fetch"] }',
        clear: true,
      }),
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ servers: Array<{ name: string; command?: string }> }>(res);
    expect(body.servers.map((server) => server.name)).toEqual(['fetch']);
    expect(body.servers[0]?.command).toBe('uvx');
  });
});

describe('路由：Skills', () => {
  function writeSkill(name: string, description: string): void {
    const dir = join(env.skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
  }

  it('GET 列表 / 停用 / 读 SKILL.md', async () => {
    writeSkill('alpha', '个人技能');

    const list = await readJson<Array<{ name: string; enabled: boolean }>>(
      await getSkills(new Request('http://localhost/api/skills')),
    );
    expect(list.map((s) => s.name)).toEqual(['alpha']);

    const toggled = await toggleSkill(jsonRequest('http://localhost/api/skills/toggle', { name: 'alpha', enabled: false }, 'PUT'));
    expect(toggled.status).toBe(200);
    expect((await readJson<Array<{ enabled: boolean }>>(toggled))[0]?.enabled).toBe(false);

    const content = await skillContent(new Request('http://localhost/api/skills/content?name=alpha&origin=personal'));
    expect(content.status).toBe(200);
    expect((await readJson<{ content: string }>(content)).content).toContain('# alpha');

    const badOrigin = await skillContent(new Request('http://localhost/api/skills/content?name=alpha&origin=nope'));
    expect(badOrigin.status).toBe(400);
    expect((await skillContent(new Request('http://localhost/api/skills/content?name=missing&origin=personal'))).status).toBe(404);
  });
});

describe('路由：资料查询', () => {
  it('没配供应商时测试连接返回 200 + 中文原因', async () => {
    const res = await testResearchRoute(jsonRequest('http://localhost/api/research/test', {}));
    expect(res.status).toBe(200);
    const body = await readJson<{ ok: boolean; reason: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('DeepSeek');
  });

  it('资料查询设置可整块保存并读回（没有启用开关）', async () => {
    const put = await putSettings(
      jsonRequest(
        'http://localhost/api/settings',
        { research: { providerId: null, baseUrl: 'https://api.deepseek.com', count: 5, needContent: true } },
        'PUT',
      ),
    );
    expect(put.status).toBe(200);
    const putBody = await readJson<{ settings: { research: { count: number; needContent: boolean } } }>(put);
    expect(putBody.settings.research).toMatchObject({ count: 5, needContent: true });

    const get = await getSettings(new Request('http://localhost/api/settings'));
    const getBody = await readJson<{ settings: { research: { count: number } } }>(get);
    expect(getBody.settings.research).toMatchObject({ count: 5 });
  });

  it('GET 数据源清单：web 必查，其余源免 key', async () => {
    const res = await researchSources(new Request('http://localhost/api/research/sources'));
    expect(res.status).toBe(200);
    const list = await readJson<Array<{ id: string; always: boolean; needsKey: boolean }>>(res);
    expect(list.find((item) => item.id === 'web')).toMatchObject({ always: true });
    expect(list.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'web',
        'crossref',
        'openalex',
        'europepmc',
        'pubmed',
        'doaj',
        'arxiv',
        'gutenberg',
        'gbif',
        'clinicaltrials',
        'worldbank',
        'eurostat',
      ]),
    );
    expect(list.every((item) => item.needsKey === false)).toBe(true);
  });
});

describe('路由：生图（火山引擎）', () => {
  it('GET 默认关闭/flash、无临时存储；PUT 只回掩码，空 key 保持原值', async () => {
    const initial = await readJson<{
      enabled: boolean;
      model: string;
      size: string;
      hasKey: boolean;
      tempStorageUrl?: string;
    }>(await getSeedream(new Request('http://localhost/api/seedream')));
    expect(initial).toMatchObject({
      enabled: false,
      model: 'doubao-seedream-5-0-flash-260915',
      size: '1536x1024',
      hasKey: false,
    });
    expect(initial.tempStorageUrl).toBeUndefined();

    const put = await putSeedream(
      jsonRequest(
        'http://localhost/api/seedream',
        { enabled: true, apiKey: 'ark-secret-3a0f', size: '2048x1152' },
        'PUT',
      ),
    );
    expect(put.status).toBe(200);
    const raw = await put.text();
    expect(raw).not.toContain('ark-secret-3a0f');
    const body = JSON.parse(raw) as { hasKey: boolean; apiKey: string; enabled: boolean; size: string };
    expect(body.hasKey).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.size).toBe('2048x1152');
    expect(body.apiKey).toContain('…');

    const keep = await putSeedream(
      jsonRequest('http://localhost/api/seedream', { baseUrl: 'https://ark.example/api/v3' }, 'PUT'),
    );
    expect(keep.status).toBe(200);
    const kept = await readJson<{ hasKey: boolean; baseUrl: string }>(keep);
    expect(kept.hasKey).toBe(true);
    expect(kept.baseUrl).toBe('https://ark.example/api/v3');

    const get = await readJson<Record<string, unknown>>(
      await getSeedream(new Request('http://localhost/api/seedream')),
    );
    expect(get.hasKey).toBe(true);
    expect(JSON.stringify(get)).not.toContain('ark-secret-3a0f');
  });

  it('PUT 启用但没有 key → 400', async () => {
    const res = await putSeedream(jsonRequest('http://localhost/api/seedream', { enabled: true }, 'PUT'));
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain('API Key');
  });

  it('测试连接路由：Ark 参数校验 400 + Files API 上传/预签名下载成功', async () => {
    await putSeedream(
      jsonRequest('http://localhost/api/seedream', { enabled: true, apiKey: 'ark-secret-3a0f' }, 'PUT'),
    );
    vi.stubGlobal(
      'fetch',
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/images/generations')) {
          return new Response(JSON.stringify({ error: { code: 'InvalidParameter', message: 'bad size' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (method === 'POST' && url.endsWith('/files')) {
          return new Response(
            JSON.stringify({
              object: 'file',
              id: 'file-test',
              purpose: 'user_data',
              filename: 'hash',
              bytes: 68,
              mime_type: 'image/png',
              created_at: 1,
              expire_at: 2,
              status: 'active',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`unexpected ${method} ${url}`);
      }) as typeof fetch,
    );

    const res = await testSeedreamRoute();
    expect(res.status).toBe(200);
    const body = await readJson<{
      ok: boolean;
      arkOk: boolean;
      files: { ok: boolean; fileId: string | null } | null;
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.arkOk).toBe(true);
    expect(body.files?.ok).toBe(true);
    expect(body.files?.fileId).toBe('file-test');
  });
});
