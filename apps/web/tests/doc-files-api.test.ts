import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveArtifact, resolveStorageRoot } from '@aidocs/api';
import type { DocFileContent, DocFileListing } from '@aidocs/contracts';
import { POST as createDoc } from '../app/api/docs/route';
import { GET as getContent } from '../app/api/docs/[group]/[name]/files/content/route';
import { GET as getRaw } from '../app/api/docs/[group]/[name]/files/raw/route';
import { GET as getFiles } from '../app/api/docs/[group]/[name]/files/route';
import { PUT as putSettings } from '../app/api/settings/route';
import { isolateEnv, jsonRequest, readJson } from './helpers';

const GROUP = '分组';
const NAME = '文档';

let env: ReturnType<typeof isolateEnv>;
let root: string;

beforeEach(async () => {
  env = isolateEnv();
  root = mkdtempSync(join(tmpdir(), 'aidocs-doc-files-route-'));
  expect(
    (await putSettings(jsonRequest('http://localhost/api/settings', { storageRoot: join(root, 'store') }, 'PUT'))).status,
  ).toBe(200);
  expect(
    (await createDoc(jsonRequest('http://localhost/api/docs', { group: GROUP, name: NAME, type: '类型' }))).status,
  ).toBe(200);

  const dir = resolveArtifact(resolveStorageRoot(), GROUP, NAME).dir;
  mkdirSync(join(dir, 'assets', 'images'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'images', 'a.png'), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, 'research', '笔记.md'), '# 笔记\n');
});
afterEach(() => {
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

function ctx() {
  return { params: Promise.resolve({ group: GROUP, name: NAME }) };
}

describe('路由：文档文件夹', () => {
  it('GET files 返回目录树', async () => {
    const res = await getFiles(new Request('http://localhost/api/files'), ctx());
    expect(res.status).toBe(200);
    const listing = await readJson<DocFileListing>(res);
    expect(listing.root).toBe(`docs/${GROUP}/${NAME}`);
    expect(listing.fileCount).toBe(4);
    expect(listing.truncated).toBe(false);
    expect(JSON.stringify(listing.entries)).toContain('assets/images/a.png');
  });

  it('GET files/content：文本预览、缺参数 400、穿越 400、缺失 404', async () => {
    const main = await getContent(new Request('http://localhost/api/files/content?path=MAIN.md'), ctx());
    expect(main.status).toBe(200);
    expect(await readJson<DocFileContent>(main)).toMatchObject({ path: 'MAIN.md', kind: 'text', truncated: false });

    const missingParam = await getContent(new Request('http://localhost/api/files/content'), ctx());
    expect(missingParam.status).toBe(400);
    expect((await readJson<{ error: string }>(missingParam)).error).toContain('path');

    const traversal = await getContent(
      new Request(`http://localhost/api/files/content?path=${encodeURIComponent('../secret.txt')}`),
      ctx(),
    );
    expect(traversal.status).toBe(400);

    const missing = await getContent(
      new Request(`http://localhost/api/files/content?path=${encodeURIComponent('research/missing.md')}`),
      ctx(),
    );
    expect(missing.status).toBe(404);
  });

  it('GET files/raw：图片 inline + ETag/304；文本 attachment；缺参数 400', async () => {
    const raw = await getRaw(
      new Request(`http://localhost/api/files/raw?path=${encodeURIComponent('assets/images/a.png')}`),
      ctx(),
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(raw.headers.get('content-disposition')).toBe('inline');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await raw.arrayBuffer())]).toEqual([1, 2, 3]);

    const etag = raw.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cached = await getRaw(
      new Request(`http://localhost/api/files/raw?path=${encodeURIComponent('assets/images/a.png')}`, {
        headers: { 'if-none-match': etag ?? '' },
      }),
      ctx(),
    );
    expect(cached.status).toBe(304);

    const text = await getRaw(new Request('http://localhost/api/files/raw?path=MAIN.md'), ctx());
    expect(text.status).toBe(200);
    expect(text.headers.get('content-disposition')).toContain('attachment');

    const missingParam = await getRaw(new Request('http://localhost/api/files/raw'), ctx());
    expect(missingParam.status).toBe(400);
  });
});
