import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchifyError } from './types';
import { ensureArchifyView, listArchify, previewArchifyIr, readArchify, saveArchify, validateArchifyIr } from './store';
import { ARCHIFY_TYPES } from './types';
import { archifySkeleton } from './guidelines';

const IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '架构烟雾测试' },
  components: [
    { id: 'a', type: 'frontend', label: '入口', pos: [40, 60], size: [140, 64] },
    { id: 'b', type: 'backend', label: '服务', pos: [260, 60], size: [140, 64] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: '调用' }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidocs-archify-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('@aidocs/archify', () => {
  it(
    '保存 IR：校验/渲染/提取海报/缓存，返回 revision',
    async () => {
      const saved = await saveArchify(dir, { type: 'architecture', title: '架构烟雾测试', ir: IR, actor: 'ai' });
      expect(saved.sourcePath).toBe('assets/diagrams/架构烟雾测试.archify.json');
      expect(saved.posterPath).toBe('assets/diagrams/架构烟雾测试.archify.svg');
      expect(saved.revision).toHaveLength(64);
      expect(existsSync(join(dir, saved.sourcePath))).toBe(true);
      const poster = readFileSync(join(dir, saved.posterPath), 'utf8');
      expect(poster).toContain('<svg');
      expect(poster).toContain('<style');
      expect(poster).toContain('data-theme="light"');
      expect(poster).not.toContain('<script');
      expect(poster.length).toBeLessThan(800 * 1024);
      expect(existsSync(join(dir, '.aidocs/archify/diagrams/架构烟雾测试.archify.html'))).toBe(true);
    },
    60_000,
  );

  it(
    '10 种类型的 skeleton 都能通过 schema 校验',
    async () => {
      for (const type of ARCHIFY_TYPES) {
        const result = await validateArchifyIr(dir, type, archifySkeleton(type), 'standard', type);
        expect(result.diagnostics, `${type}: ${JSON.stringify(result.diagnostics.slice(0, 2))}`).toEqual([]);
        expect(result.ok, type).toBe(true);
      }
    },
    120_000,
  );

  it(
    '实时预览：渲染到 .aidocs 缓存，不写源/海报；非法 IR 返回诊断',
    async () => {
      const preview = await previewArchifyIr(dir, 'architecture', IR, 'standard');
      expect(preview.ok).toBe(true);
      expect(preview.previewPath).toMatch(/^\.aidocs\/archify\/preview\/[0-9a-f]{64}\.html$/);
      expect(existsSync(join(dir, preview.previewPath!))).toBe(true);
      expect(readFileSync(join(dir, preview.previewPath!), 'utf8')).toContain('data-aidocs-archify-bridge');
      expect(existsSync(join(dir, 'assets'))).toBe(false);

      const cached = await previewArchifyIr(dir, 'architecture', IR, 'standard');
      expect(cached.previewPath).toBe(preview.previewPath);

      const bad = await previewArchifyIr(dir, 'architecture', {
        ...IR,
        components: [{ id: 'a', label: '缺 type' }],
      }, 'standard');
      expect(bad.ok).toBe(false);
      expect(bad.diagnostics.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    '读取/列表/交互缓存',
    async () => {
      const saved = await saveArchify(dir, { type: 'architecture', title: '列表图', ir: IR });
      const read = readArchify(dir, saved.sourcePath);
      expect(read.type).toBe('architecture');
      expect(read.revision).toBe(saved.revision);
      expect(read.ir.meta).toMatchObject({ locale: 'zh-CN', visual_preset: 'classic', animation: 'trace' });
      expect(listArchify(dir).map((item) => item.sourcePath)).toContain(saved.sourcePath);
      const view = await ensureArchifyView(dir, saved.sourcePath);
      expect(view.html).toContain('<!DOCTYPE html>');
      expect(view.html.length).toBeGreaterThan(10_000);
    },
    60_000,
  );

  it(
    '新图默认自动排版；更新已有图默认保留坐标',
    async () => {
      const chain = {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: '自动排版测试' },
        components: [
          { id: 'a', type: 'frontend', label: '入口', pos: [220, 220], size: [120, 60] },
          { id: 'b', type: 'backend', label: '服务', pos: [40, 40], size: [120, 60] },
          { id: 'c', type: 'database', label: '数据库', pos: [420, 10], size: [120, 60] },
        ],
        connections: [
          { from: 'a', to: 'b', label: '调用' },
          { from: 'b', to: 'c', label: '读写' },
        ],
      };
      const saved = await saveArchify(dir, { type: 'architecture', title: '自动排版测试', ir: chain, actor: 'ai' });
      expect(saved.warnings.some((warning) => warning.includes('已自动排版'))).toBe(true);
      expect(saved.layout?.score).toBe(100);
      const components = saved.ir.components as Array<{ id: string; pos: number[]; size: number[] }>;
      expect(components.find((component) => component.id === 'a')?.pos).toEqual([40, 40]);
      expect(components.find((component) => component.id === 'b')?.pos).toEqual([260, 40]);
      expect(components.find((component) => component.id === 'c')?.pos).toEqual([260, 150]);
      for (const component of components) expect(component.size).toEqual([150, 56]);

      const custom = {
        ...chain,
        components: chain.components.map((component) => ({ ...component, pos: component.pos as [number, number] })),
      };
      const updated = await saveArchify(dir, {
        type: 'architecture',
        title: '自动排版测试 v2',
        ir: custom,
        sourcePath: saved.sourcePath,
        actor: 'ai',
      });
      const updatedComponents = updated.ir.components as Array<{ id: string; pos: number[] }>;
      expect(updatedComponents.find((component) => component.id === 'a')?.pos).toEqual([220, 220]);
    },
    60_000,
  );

  it(
    '8 节点架构自动排版后布局体检 100 分',
    async () => {
      const arch = {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: '八节点架构' },
        components: [
          { id: 'client', type: 'frontend', label: '客户端 App', sublabel: 'Web / Mobile' },
          { id: 'edge', type: 'cloud', label: 'Edge CDN', sublabel: '静态与缓存' },
          { id: 'gw', type: 'backend', label: 'API Gateway', sublabel: '鉴权 / 限流' },
          { id: 'auth', type: 'security', label: 'Auth', sublabel: 'JWT / OIDC' },
          { id: 'orders', type: 'backend', label: 'Order Service', sublabel: '订单' },
          { id: 'users', type: 'backend', label: 'User Service', sublabel: '用户' },
          { id: 'redis', type: 'database', label: 'Redis', sublabel: '缓存 / 会话' },
          { id: 'pg', type: 'database', label: 'PostgreSQL', sublabel: '主数据' },
        ],
        connections: [
          { from: 'client', to: 'edge', label: 'HTTPS' },
          { from: 'edge', to: 'gw', label: '回源' },
          { from: 'gw', to: 'auth', label: '校验 token' },
          { from: 'gw', to: 'orders', label: '/orders' },
          { from: 'gw', to: 'users', label: '/users' },
          { from: 'orders', to: 'pg', label: '读写' },
          { from: 'users', to: 'redis', label: '缓存' },
        ],
      };
      const saved = await saveArchify(dir, { type: 'architecture', title: '八节点架构', ir: arch, actor: 'ai' });
      expect(saved.layout?.score).toBe(100);
      expect(saved.layout?.issues).toEqual([]);
      expect(saved.warnings.some((warning) => warning.includes('已自动排版'))).toBe(true);
      expect(existsSync(join(dir, saved.posterPath))).toBe(true);
    },
    60_000,
  );

  it(
    '手工坐标的原始示例会被布局体检标出折点/贴边/画布比例',
    async () => {
      const bad = {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: '布局体检示例' },
        components: [
          { id: 'client', type: 'frontend', label: '客户端 App', sublabel: 'Web / Mobile', pos: [40, 80], size: [150, 66] },
          { id: 'edge', type: 'cloud', label: 'Edge CDN', sublabel: '静态与缓存', pos: [260, 80], size: [150, 66] },
          { id: 'gw', type: 'backend', label: 'API Gateway', sublabel: '鉴权 / 限流', pos: [480, 80], size: [160, 66] },
          { id: 'auth', type: 'security', label: 'Auth', sublabel: 'JWT / OIDC', pos: [720, 20], size: [140, 66] },
          { id: 'orders', type: 'backend', label: 'Order Service', sublabel: '订单', pos: [720, 140], size: [150, 66] },
          { id: 'users', type: 'backend', label: 'User Service', sublabel: '用户', pos: [920, 140], size: [150, 66] },
          { id: 'redis', type: 'database', label: 'Redis', sublabel: '缓存 / 会话', pos: [480, 240], size: [140, 66] },
          { id: 'pg', type: 'database', label: 'PostgreSQL', sublabel: '主数据', pos: [720, 240], size: [150, 66] },
        ],
        connections: [
          { from: 'client', to: 'edge', label: 'HTTPS' },
          { from: 'edge', to: 'gw', label: '回源' },
          { from: 'gw', to: 'auth', label: '校验 token' },
          { from: 'gw', to: 'orders', label: '/orders' },
          { from: 'gw', to: 'users', label: '/users' },
          { from: 'orders', to: 'pg', label: '读写' },
          { from: 'users', to: 'redis', label: '缓存' },
        ],
      };
      const result = await validateArchifyIr(dir, 'architecture', bad, 'showcase');
      expect(result.ok).toBe(true);
      expect(result.layout?.score).toBeLessThan(100);
      const codes = result.layout?.issues.map((issue) => issue.code) ?? [];
      expect(codes).toContain('layout/edge-bends');
      expect(codes).toContain('layout/clearance');
      expect(codes).toContain('layout/canvas-aspect');
      expect(codes).toContain('layout/card-uniformity');
      expect(result.warnings.some((warning) => warning.includes('布局') || warning.includes('折点'))).toBe(true);
    },
    60_000,
  );

  it(
    'workflow 泳道留白与 phase band 回归',
    async () => {
      const workflow = {
        schema_version: 2,
        diagram_type: 'workflow',
        meta: { title: '泳道留白测试' },
        lanes: [
          { id: 'dev', label: '开发者' },
          { id: 'ci', label: 'CI 流水线' },
        ],
        phases: [
          { id: 'p0', label: '① 提交', fromCol: 0, toCol: 0 },
          { id: 'p1', label: '② 集成', fromCol: 1, toCol: 2 },
        ],
        nodes: [
          { id: 'commit', lane: 'dev', col: 0, type: 'frontend', label: '提交代码', sublabel: 'push', tag: '起点' },
          { id: 'trigger', lane: 'ci', col: 1, type: 'backend', label: '触发流水线', sublabel: 'webhook' },
          { id: 'build', lane: 'ci', col: 2, type: 'backend', label: '构建与测试', sublabel: '单测', tag: '自动门禁' },
        ],
        edges: [
          { from: 'commit', to: 'trigger' },
          { from: 'trigger', to: 'build' },
        ],
      };
      const saved = await saveArchify(dir, { type: 'workflow', title: '泳道留白测试', ir: workflow, actor: 'ai' });
      const poster = readFileSync(join(dir, saved.posterPath), 'utf8');
      expect(poster).toContain('phase-band');
      expect(poster).not.toContain(' phase-rule"');
      const heights = [...poster.matchAll(/<rect[^>]*height="([\d.]+)"[^>]*class="c-lane"/g)].map((match) => Number(match[1]));
      expect(heights.length).toBe(2);
      expect(heights.every((height) => height === 122)).toBe(true);
    },
    60_000,
  );

  it(
    'dataflow 的 stage 框按各自行收紧',
    async () => {
      const dataflow = {
        schema_version: 1,
        diagram_type: 'dataflow',
        meta: { title: '数据流留白测试' },
        stages: [{ label: '采集' }, { label: '清洗' }, { label: '发布' }],
        nodes: [
          { id: 'events', type: 'external', label: '埋点事件', stage: 0, row: 0 },
          { id: 'kafka', type: 'messagebus', label: 'Kafka', stage: 1, row: 0 },
          { id: 'model', type: 'backend', label: '训练任务', stage: 2, row: 0 },
          { id: 'metrics', type: 'database', label: '指标库', stage: 2, row: 1 },
        ],
        flows: [
          { from: 'events', to: 'kafka', label: 'JSON' },
          { from: 'kafka', to: 'model', label: '消费' },
          { from: 'model', to: 'metrics', label: '指标', variant: 'dashed' },
        ],
      };
      const saved = await saveArchify(dir, { type: 'dataflow', title: '数据流留白测试', ir: dataflow, actor: 'ai' });
      const poster = readFileSync(join(dir, saved.posterPath), 'utf8');
      const heights = [...poster.matchAll(/<rect[^>]*height="([\d.]+)"[^>]*class="c-lane"/g)].map((match) => Number(match[1]));
      expect(heights).toEqual([162, 162, 276]);
    },
    60_000,
  );

  it(
    'timeline 的 event.detail 进入海报卡片第二行',
    async () => {
      const timeline = {
        schema_version: 1,
        diagram_type: 'timeline',
        meta: { title: '发布事故时间线', evidence: 'illustrative', timezone: 'Asia/Shanghai' },
        lanes: [{ id: 'app', label: '应用' }],
        events: [
          { id: 'e1', at: '2026-10-17T09:00:00+08:00', title: '发布 v2.3', lane: 'app', kind: 'change' },
          { id: 'e2', at: '2026-10-17T09:12:00+08:00', title: '错误率上升', lane: 'app', kind: 'alert', detail: '5xx 从 0.2% 到 8%' },
        ],
      };
      const saved = await saveArchify(dir, { type: 'timeline', title: '发布事故时间线', ir: timeline, actor: 'ai' });
      const poster = readFileSync(join(dir, saved.posterPath), 'utf8');
      expect(poster).toContain('5xx 从 0.2% 到 8%');
      expect(poster).toContain('font-size="8.5"');
    },
    60_000,
  );

  it(
    '非法 IR 返回 diagnostics 且不写源',
    async () => {
      await expect(
        saveArchify(dir, {
          type: 'architecture',
          title: '坏图',
          ir: { ...IR, components: [{ id: 'a', label: '缺 type' }] },
        }),
      ).rejects.toBeInstanceOf(ArchifyError);
      expect(existsSync(join(dir, 'assets/diagrams/坏图.archify.json'))).toBe(false);
    },
    60_000,
  );
});
