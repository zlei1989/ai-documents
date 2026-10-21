import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStorageRoot } from '@aidocs/api';
import { GET, PATCH, POST } from '../app/api/docs/[group]/[name]/sessions/route';
import { isolateEnv, jsonRequest, readJson } from './helpers';

let env: ReturnType<typeof isolateEnv>;
let root: string;

const context = { params: Promise.resolve({ group: '分组', name: '文档' }) };

beforeEach(() => {
  env = isolateEnv();
  root = mkdtempSync(join(tmpdir(), 'aidocs-session-routes-'));
  setStorageRoot(root);
  mkdirSync(join(root, 'docs', '分组', '文档'), { recursive: true });
});

afterEach(() => {
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

describe('路由：创作会话', () => {
  it('GET 首次打开自动建会话；POST 新建；PATCH 切回', async () => {
    const first = await GET(new Request('http://localhost/api/docs/分组/文档/sessions'), context);
    expect(first.status).toBe(200);
    const initial = await readJson<{ activeId: string; sessions: Array<{ id: string; status: string }> }>(first);
    expect(initial.sessions).toHaveLength(1);
    expect(initial.sessions[0]?.status).toBe('idle');

    const createdRes = await POST(new Request('http://localhost/api/docs/分组/文档/sessions', { method: 'POST' }), context);
    expect(createdRes.status).toBe(200);
    const created = await readJson<{ activeId: string }>(createdRes);
    expect(created.activeId).not.toBe(initial.activeId);

    const patchedRes = await PATCH(
      jsonRequest('http://localhost/api/docs/分组/文档/sessions', { activeId: initial.activeId }, 'PATCH'),
      context,
    );
    expect(patchedRes.status).toBe(200);
    expect((await readJson<{ activeId: string }>(patchedRes)).activeId).toBe(initial.activeId);
  });

  it('切换不存在的会话 404；缺参数 400；文档不存在 404', async () => {
    await GET(new Request('http://localhost/api/docs/分组/文档/sessions'), context);

    const missing = await PATCH(
      jsonRequest('http://localhost/api/docs/分组/文档/sessions', { activeId: 'missing' }, 'PATCH'),
      context,
    );
    expect(missing.status).toBe(404);
    expect((await readJson<{ error: string }>(missing)).error).toContain('会话不存在');

    const bad = await PATCH(jsonRequest('http://localhost/api/docs/分组/文档/sessions', {}, 'PATCH'), context);
    expect(bad.status).toBe(400);

    const noDoc = await GET(
      new Request('http://localhost/api/docs/分组/不存在/sessions'),
      { params: Promise.resolve({ group: '分组', name: '不存在' }) },
    );
    expect(noDoc.status).toBe(404);
  });
});
