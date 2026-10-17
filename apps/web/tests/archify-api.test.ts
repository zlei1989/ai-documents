import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveArchify } from '@aidocs/archify';
import { resolveArtifact, resolveStorageRoot } from '@aidocs/api';
import { POST as createDoc } from '../app/api/docs/route';
import { GET as getArchify, PUT as putArchify } from '../app/api/docs/[group]/[name]/archify/[...path]/route';
import { POST as validateArchifyRoute } from '../app/api/docs/[group]/[name]/archify-validate/route';
import { POST as layoutArchifyRoute } from '../app/api/docs/[group]/[name]/archify-layout/route';
import { GET as getArchifyView } from '../app/api/docs/[group]/[name]/archify-view/[...path]/route';
import { POST as previewArchifyRoute } from '../app/api/docs/[group]/[name]/archify-preview/route';
import { GET as getArchifyPreview } from '../app/api/docs/[group]/[name]/archify-preview/[...path]/route';
import { GET as getAsset, HEAD as headAsset } from '../app/api/docs/[group]/[name]/assets/[...path]/route';
import { PUT as putSettings } from '../app/api/settings/route';
import { isolateEnv, jsonRequest, readJson } from './helpers';

const IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '路由架构' },
  components: [
    { id: 'a', type: 'frontend', label: '入口', pos: [40, 60], size: [140, 64] },
    { id: 'b', type: 'backend', label: '服务', pos: [260, 60], size: [140, 64] },
  ],
  connections: [{ from: 'a', to: 'b', label: '调用' }],
};

const GROUP = '产品';
const NAME = 'Archify文档';
const SOURCE = 'assets/diagrams/route-test.archify.json';

let env: ReturnType<typeof isolateEnv>;
let root: string;

beforeEach(async () => {
  env = isolateEnv();
  root = mkdtempSync(join(tmpdir(), 'aidocs-archify-route-'));
  expect((await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: join(root, 'docs') }, 'PUT'))).status).toBe(200);
  expect((await createDoc(jsonRequest('http://localhost/api/docs', { group: GROUP, name: NAME, type: '技术方案' }))).status).toBe(200);
  await saveArchify(resolveArtifact(resolveStorageRoot(), GROUP, NAME).dir, {
    type: 'architecture',
    title: '路由架构',
    ir: IR,
    sourcePath: SOURCE,
    quality: 'standard',
    actor: 'ai',
  });
});
afterEach(() => {
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

function ctx(path: string[]) {
  return { params: Promise.resolve({ group: GROUP, name: NAME, path }) };
}

const segments = SOURCE.split('/');

describe('路由：Archify', () => {
  it(
    'GET 读源；PUT revision 保存；过期 409',
    async () => {
      const got = await getArchify(new Request('http://localhost/api/archify'), ctx(segments));
      expect(got.status).toBe(200);
      const doc = await readJson<{ revision: string; ir: Record<string, unknown>; interactiveUrl: string }>(got);
      expect(doc.revision).toHaveLength(64);
      expect(doc.interactiveUrl).toContain('/archify-view/');

      const nextIr = { ...IR, meta: { title: '路由架构 v2' } };
      const saved = await putArchify(
        jsonRequest('http://localhost/api/archify', { ir: nextIr, baseRevision: doc.revision, quality: 'standard' }, 'PUT'),
        ctx(segments),
      );
      expect(saved.status).toBe(200);
      expect((await readJson<{ title: string }>(saved)).title).toBe('路由架构 v2');

      const stale = await putArchify(
        jsonRequest('http://localhost/api/archify', { ir: nextIr, baseRevision: doc.revision, quality: 'standard' }, 'PUT'),
        ctx(segments),
      );
      expect(stale.status).toBe(409);
    },
    60_000,
  );

  it(
    'validate 路由；view 沙箱/CSP；海报保留 CSS class',
    async () => {
      const validated = await validateArchifyRoute(
        jsonRequest('http://localhost/api/archify-validate', { type: 'architecture', ir: IR, quality: 'standard' }),
        { params: Promise.resolve({ group: GROUP, name: NAME }) },
      );
      expect(validated.status).toBe(200);
      expect(await readJson<{ ok: boolean; layout: { score: number } | null }>(validated)).toMatchObject({
        ok: true,
        layout: { score: 100 },
      });

      const view = await getArchifyView(new Request('http://localhost/api/archify-view'), ctx(segments));
      expect(view.status).toBe(200);
      expect(view.headers.get('content-type')).toContain('text/html');
      expect(view.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(await view.text()).toContain('data-aidocs-archify-bridge');

      const poster = await getAsset(
        new Request('http://localhost/api/assets'),
        ctx(['diagrams', 'route-test.archify.svg']),
      );
      expect(poster.status).toBe(200);
      expect(poster.headers.get('content-type')).toContain('image/svg+xml');
      const svg = await poster.text();
      expect(svg).toContain('<style');
      expect(svg).toContain('class=');
      expect(svg).not.toContain('<script');
    },
    60_000,
  );

  it(
    '实时预览：POST 渲染缓存并返回 URL；GET 以 sandbox CSP 提供',
    async () => {
      const preview = await previewArchifyRoute(
        jsonRequest('http://localhost/api/archify-preview', { type: 'architecture', ir: IR, quality: 'standard' }),
        { params: Promise.resolve({ group: GROUP, name: NAME }) },
      );
      expect(preview.status).toBe(200);
      const result = await readJson<{ ok: boolean; previewUrl: string | null }>(preview);
      expect(result.ok).toBe(true);
      expect(result.previewUrl).toContain('/archify-preview/.aidocs/archify/preview/');

      const pathname = new URL(result.previewUrl!, 'http://localhost').pathname;
      const prefix = `/api/docs/${encodeURIComponent(GROUP)}/${encodeURIComponent(NAME)}/archify-preview/`;
      const relative = decodeURIComponent(pathname.slice(prefix.length));
      const view = await getArchifyPreview(
        new Request('http://localhost/api/archify-preview'),
        ctx(relative.split('/')),
      );
      expect(view.status).toBe(200);
      expect(view.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(await view.text()).toContain('data-aidocs-archify-bridge');
    },
    60_000,
  );

  it(
    '普通 SVG 只读资源：净化、CSP、ETag/304、HEAD',
    async () => {
      const rel = join(resolveArtifact(resolveStorageRoot(), GROUP, NAME).dir, 'assets', 'diagrams', 'manual.svg');
      writeFileSync(
        rel,
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>.a{fill:red}</style><rect class="a" width="10" height="10"/><script>alert(1)</script></svg>',
      );
      const url = 'http://localhost/api/assets';
      const res = await getAsset(new Request(url), ctx(['diagrams', 'manual.svg']));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      const svg = await res.text();
      expect(svg).toContain('class="a"');
      expect(svg).not.toContain('<script');

      const notModified = await getAsset(new Request(url, { headers: { 'if-none-match': etag } }), ctx(['diagrams', 'manual.svg']));
      expect(notModified.status).toBe(304);
      const head = await headAsset(new Request(url, { method: 'HEAD' }), ctx(['diagrams', 'manual.svg']));
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(etag);
    },
    60_000,
  );

  it(
    '排版：只返回变换后的 IR，不写盘',
    async () => {
      const response = await layoutArchifyRoute(
        jsonRequest('http://localhost/api/archify-layout', { type: 'architecture', ir: IR }, 'POST'),
        { params: Promise.resolve({ group: GROUP, name: NAME }) },
      );
      expect(response.status).toBe(200);
      const result = await readJson<{ applied: boolean; ir: { components: Array<{ id: string; pos: number[]; size: number[] }> } }>(response);
      expect(result.applied).toBe(true);
      const components = result.ir.components;
      expect(components.find((component) => component.id === 'a')?.pos).toEqual([40, 40]);
      expect(components.find((component) => component.id === 'b')?.pos).toEqual([260, 40]);
      expect(components.every((component) => component.size[0] === 150 && component.size[1] === 56)).toBe(true);
    },
    60_000,
  );

  it('非法路径/非法 IR 返回 400', async () => {
    const badPath = await getArchify(new Request('http://localhost/api/archify'), ctx(['..', 'x.archify.json']));
    expect(badPath.status).toBe(400);
    const badIr = await validateArchifyRoute(
      jsonRequest('http://localhost/api/archify-validate', {
        type: 'architecture',
        ir: { ...IR, components: [{ id: 'a', label: '缺 type' }] },
        quality: 'standard',
      }),
      { params: Promise.resolve({ group: GROUP, name: NAME }) },
    );
    expect(badIr.status).toBe(200);
    expect(await readJson<{ ok: boolean }>(badIr)).toMatchObject({ ok: false });
  }, 60_000);
});
