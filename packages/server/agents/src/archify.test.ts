import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createArchifyExtension } from './archify';

interface RegisteredTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}

const IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '工具测试' },
  components: [
    { id: 'a', type: 'frontend', label: '入口', pos: [40, 60], size: [140, 64] },
    { id: 'b', type: 'backend', label: '服务', pos: [260, 60], size: [140, 64] },
  ],
  connections: [{ from: 'a', to: 'b', label: '调用' }],
};

function register(dir: string) {
  const tools: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => tools.push(tool) } as unknown as ExtensionAPI;
  createArchifyExtension({ artifactDir: dir })(pi);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { tools, tool: (name: string) => byName.get(name)! };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidocs-archify-agent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createArchifyExtension', () => {
  it('注册两个工具并带提示词', () => {
    const { tools, tool } = register(dir);
    expect(tools.map((item) => item.name)).toEqual(['archify_guidelines', 'archify_save']);
    expect(tool('archify_guidelines').promptSnippet).toContain('图示类型规范');
    expect(tool('archify_save').promptSnippet).toContain('Archify');
    expect(tool('archify_save').promptGuidelines?.join('\n')).toContain('MAIN.md');
  });

  it('guidelines 返回指定类型 skeleton 与约束', async () => {
    const { tool } = register(dir);
    const result = await tool('archify_guidelines').execute('t1', { type: 'sequence' });
    expect(result.content[0]?.text).toContain('类型：sequence');
    expect(result.content[0]?.text).toContain('participants');
    expect(result.content[0]?.text).toContain('messages');
  });

  it(
    'save 写 .archify.json/.archify.svg，返回 Markdown 引用并注入默认 meta',
    async () => {
      const { tool } = register(dir);
      const result = await tool('archify_save').execute('t1', {
        type: 'architecture',
        ir: JSON.stringify(IR),
        title: '工具测试',
      });
      const details = result.details as { sourcePath: string; posterPath: string; markdown: string };
      expect(details.sourcePath).toBe('assets/diagrams/工具测试.archify.json');
      expect(details.posterPath).toBe('assets/diagrams/工具测试.archify.svg');
      expect(details.markdown).toBe('![工具测试](assets/diagrams/工具测试.archify.svg)');
      expect(result.content[0]?.text).toContain('布局体检');
      expect(result.details.layout).toMatchObject({ score: 100 });
      const source = JSON.parse(readFileSync(join(dir, details.sourcePath), 'utf8')) as Record<string, unknown>;
      expect(source.meta).toMatchObject({ locale: 'zh-CN', visual_preset: 'classic', animation: 'trace' });
      expect(existsSync(join(dir, details.posterPath))).toBe(true);
      expect(readFileSync(join(dir, details.posterPath), 'utf8')).toContain('<style');
    },
    60_000,
  );

  it(
    '更新已有源 JSON 不需要 baseRevision，保留 revision',
    async () => {
      const { tool } = register(dir);
      const first = await tool('archify_save').execute('t1', {
        type: 'architecture',
        ir: JSON.stringify(IR),
        title: '更新测试',
      });
      const firstDetails = first.details as { sourcePath: string };
      const nextIr = {
        ...IR,
        meta: { title: '更新测试 v2' },
        components: IR.components.map((component) =>
          component.id === 'a' ? { ...component, label: '新入口' } : component,
        ),
      };
      const updated = await tool('archify_save').execute('t2', {
        type: 'architecture',
        ir: JSON.stringify(nextIr),
        title: '更新测试 v2',
        path: firstDetails.sourcePath,
      });
      const details = updated.details as { sourcePath: string; revision: string };
      expect(details.sourcePath).toBe(firstDetails.sourcePath);
      expect(details.revision).not.toBe((first.details as { revision: string }).revision);
      const source = JSON.parse(readFileSync(join(dir, details.sourcePath), 'utf8')) as {
        components: Array<{ id: string; label: string }>;
      };
      expect(source.components.find((component) => component.id === 'a')?.label).toBe('新入口');
    },
    60_000,
  );

  it(
    '非法 IR 返回 diagnostics 且不写文件',
    async () => {
      const { tool } = register(dir);
      await expect(
        tool('archify_save').execute('t1', {
          type: 'architecture',
          ir: JSON.stringify({ ...IR, components: [{ id: 'a', label: '缺 type' }] }),
        }),
      ).rejects.toThrow(/archify_save 失败/);
      expect(existsSync(join(dir, 'assets'))).toBe(false);
    },
    60_000,
  );
});
