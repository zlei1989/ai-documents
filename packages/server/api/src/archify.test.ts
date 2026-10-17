import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDoc } from './docs';
import { readAsset } from './diagrams';
import {
  getArchifyDocument,
  getArchifyView,
  listArchifyDocuments,
  saveArchifyDocument,
  validateArchifyDocument,
} from './archify';
import { ServiceError } from './service-error';

const IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'API 架构' },
  components: [
    { id: 'a', type: 'frontend', label: '入口', pos: [40, 60], size: [140, 64] },
    { id: 'b', type: 'backend', label: '服务', pos: [260, 60], size: [140, 64] },
  ],
  connections: [{ from: 'a', to: 'b', label: '调用' }],
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aidocs-archify-api-'));
  createDoc(root, { group: '分组', name: '文档', type: '类型' });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SOURCE = 'assets/diagrams/api-test.archify.json';

describe('archify api', () => {
  it(
    '保存/读取/列表：写源 JSON、海报、交互缓存',
    async () => {
      const saved = await saveArchifyDocument(root, '分组', '文档', SOURCE, {
        ir: IR,
        quality: 'standard',
      });
      expect(saved.sourcePath).toBe(SOURCE);
      expect(saved.posterPath).toBe('assets/diagrams/api-test.archify.svg');
      expect(saved.interactiveUrl).toContain('/archify-view/');
      expect(existsSync(join(root, 'docs', '分组', '文档', SOURCE))).toBe(true);
      expect(existsSync(join(root, 'docs', '分组', '文档', saved.posterPath))).toBe(true);
      expect(existsSync(join(root, 'docs', '分组', '文档', '.aidocs', 'archify', 'diagrams', 'api-test.archify.html'))).toBe(true);

      const read = getArchifyDocument(root, '分组', '文档', SOURCE);
      expect(read.title).toBe('API 架构');
      expect(read.ir.meta).toMatchObject({ locale: 'zh-CN', visual_preset: 'classic', animation: 'trace' });
      expect(listArchifyDocuments(root, '分组', '文档').map((item) => item.sourcePath)).toEqual([SOURCE]);
    },
    60_000,
  );

  it(
    'revision 冲突 409，force 覆盖',
    async () => {
      const first = await saveArchifyDocument(root, '分组', '文档', SOURCE, {
        ir: IR,
        quality: 'standard',
      });
      await expect(
        saveArchifyDocument(root, '分组', '文档', SOURCE, {
          ir: { ...IR, meta: { title: '改标题' } },
          baseRevision: 'stale',
          quality: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const updated = await saveArchifyDocument(root, '分组', '文档', SOURCE, {
        ir: { ...IR, meta: { title: '改标题' } },
        baseRevision: first.revision,
        quality: 'standard',
      });
      expect(updated.revision).not.toBe(first.revision);
      expect(updated.title).toBe('改标题');
    },
    60_000,
  );

  it(
    'validate 返回诊断；合法 IR ok',
    async () => {
      const bad = await validateArchifyDocument(root, '分组', '文档', 'architecture', {
        ...IR,
        components: [{ id: 'a', label: '缺 type' }],
      }, 'standard');
      expect(bad.ok).toBe(false);
      expect(bad.diagnostics.length).toBeGreaterThan(0);

      const good = await validateArchifyDocument(root, '分组', '文档', 'architecture', IR, 'standard');
      expect(good.ok).toBe(true);
    },
    60_000,
  );

  it(
    'view 返回沙箱 HTML 并注入选择桥；海报保留 class/style',
    async () => {
      const saved = await saveArchifyDocument(root, '分组', '文档', SOURCE, {
        ir: IR,
        quality: 'standard',
      });
      const view = await getArchifyView(root, '分组', '文档', SOURCE);
      expect(view.html).toContain('data-aidocs-archify-bridge');
      expect(view.html.length).toBeGreaterThan(10_000);
      expect(view.revision).toBe(saved.revision);

      const poster = readAsset(root, '分组', '文档', 'diagrams/api-test.archify.svg');
      const content = poster.bytes.toString('utf8');
      expect(content).toContain('<style');
      expect(content).toContain('data-theme="light"');
      expect(content).not.toContain('<script');
    },
    60_000,
  );

  it('路径越界/非 archify 源被拒绝', async () => {
    await expect(
      saveArchifyDocument(root, '分组', '文档', 'assets/diagrams/../evil.archify.json', {
        ir: IR,
        quality: 'standard',
      }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      saveArchifyDocument(root, '分组', '文档', 'assets/diagrams/a.svg', {
        ir: IR,
        quality: 'standard',
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
