import { describe, expect, it } from 'vitest';
import { POST as aiRoute } from '../app/api/docs/[group]/[name]/archify-ai/route';
import { jsonRequest, readJson } from './helpers';

function context(): { params: Promise<{ group: string; name: string }> } {
  return { params: Promise.resolve({ group: '测试', name: '图示' }) };
}

describe('路由：Archify AI 改图入参', () => {
  it('edit 缺修改要求 → 400，不触达模型', async () => {
    const res = await aiRoute(
      jsonRequest('http://localhost/api/archify-ai', {
        mode: 'edit',
        type: 'architecture',
        ir: { schema_version: 1, diagram_type: 'architecture', components: [] },
      }),
      context(),
    );
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain('修改要求');
  });

  it('repair 缺诊断 → 400，不触达模型', async () => {
    const res = await aiRoute(
      jsonRequest('http://localhost/api/archify-ai', {
        mode: 'repair',
        type: 'architecture',
        ir: { schema_version: 1, diagram_type: 'architecture', components: [] },
      }),
      context(),
    );
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toContain('诊断');
  });
});
