import { describe, expect, it } from 'vitest';
import { layoutArchitecture, lintLayout, normalizeWorkflow } from './layout';

const ARCH = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: '边缘网关参考架构' },
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

describe('layoutArchitecture', () => {
  it('把主路径摆成 L 形，store 放在 owner 正下方，所有边保持直线', () => {
    const result = layoutArchitecture(ARCH);
    expect(result.applied).toBe(true);
    const components = result.ir.components as Array<{ id: string; pos: [number, number]; size: [number, number] }>;
    const byId = new Map(components.map((component) => [component.id, component]));
    expect(byId.get('auth')?.pos).toEqual([480, 40]);
    expect(byId.get('client')?.pos).toEqual([40, 160]);
    expect(byId.get('edge')?.pos).toEqual([260, 160]);
    expect(byId.get('gw')?.pos).toEqual([480, 160]);
    expect(byId.get('orders')?.pos).toEqual([480, 280]);
    expect(byId.get('pg')?.pos).toEqual([480, 400]);
    expect(byId.get('users')?.pos).toEqual([700, 160]);
    expect(byId.get('redis')?.pos).toEqual([700, 280]);
    for (const component of components) expect(component.size).toEqual([150, 66]);
  });

  it('保留 boundaries 时跳过自动排版', () => {
    const result = layoutArchitecture({
      ...ARCH,
      boundaries: [{ kind: 'region', label: 'VPC', wraps: ['gw', 'orders'] }],
    });
    expect(result.applied).toBe(false);
    expect(result.warnings[0]).toContain('boundaries');
  });

  it('有环时跳过自动排版', () => {
    const result = layoutArchitecture({
      ...ARCH,
      connections: [...ARCH.connections, { from: 'pg', to: 'gw', label: '回写' }],
    });
    expect(result.applied).toBe(false);
    expect(result.warnings[0]).toContain('环');
  });
});

const RECEIPT = {
  viewBox: [1110, 377] as [number, number],
  components: [
    { id: 'client', type: 'frontend', label: '客户端 App', x: 40, y: 80, width: 150, height: 66 },
    { id: 'gateway', type: 'backend', label: 'API Gateway', x: 480, y: 80, width: 160, height: 66 },
    { id: 'orders', type: 'backend', label: 'Order Service', x: 720, y: 140, width: 150, height: 66 },
    { id: 'users', type: 'backend', label: 'User Service', x: 920, y: 140, width: 150, height: 66 },
    { id: 'redis', type: 'database', label: 'Redis', x: 480, y: 240, width: 140, height: 66 },
  ],
  connections: [
    {
      from: 'gateway',
      to: 'users',
      label: '/users',
      points: [[640, 127], [664, 127], [664, 209], [896, 209], [896, 166], [920, 166]],
    },
    {
      from: 'users',
      to: 'redis',
      label: '缓存',
      points: [[995, 206], [995, 309], [644, 309], [644, 273], [620, 273]],
    },
  ],
  labels: [
    { text: '/users', x: 644.6, y: 148, width: 38.8, height: 14 },
    { text: '缓存', x: 959, y: 250.5, width: 30, height: 14 },
  ],
};

describe('lintLayout', () => {
  it('能发现折点、3px 贴边、画布过扁、卡片尺寸不统一', () => {
    const report = lintLayout('architecture', {}, RECEIPT);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('layout/edge-bends');
    expect(codes).toContain('layout/clearance');
    expect(codes).toContain('layout/canvas-aspect');
    expect(codes).toContain('layout/card-uniformity');
    expect(report.score).toBeLessThan(100);
    expect(report.summary).toContain('布局');
  });

  it('干净布局得到 100 分', () => {
    const report = lintLayout('architecture', {}, {
      viewBox: [890, 554],
      components: [
        { id: 'a', type: 'frontend', label: 'A', x: 40, y: 40, width: 150, height: 66 },
        { id: 'b', type: 'backend', label: 'B', x: 260, y: 40, width: 150, height: 66 },
      ],
      connections: [{ from: 'a', to: 'b', label: '调用', points: [[190, 73], [260, 73]] }],
      labels: [{ text: '调用', x: 203, y: 53, width: 34, height: 14 }],
    });
    expect(report.issues).toEqual([]);
    expect(report.score).toBe(100);
  });
});

const WORKFLOW = {
  schema_version: 2,
  diagram_type: 'workflow',
  meta: { title: '发布流程泳道图' },
  lanes: [
    { id: 'dev', label: '开发者' },
    { id: 'ci', label: 'CI 流水线' },
  ],
  nodes: [
    { id: 'commit', lane: 'dev', col: 0, type: 'frontend', label: '提交代码', sublabel: 'push 到特性分支', tag: '起点' },
    { id: 'trigger', lane: 'ci', col: 1, type: 'backend', label: '触发流水线', sublabel: 'webhook 自动拉起任务' },
    { id: 'build', lane: 'ci', col: 2, type: 'backend', label: '构建与测试', sublabel: '单测 · 集成测试 · 制品签名', tag: '自动门禁' },
  ],
  edges: [
    { from: 'commit', to: 'trigger' },
    { from: 'trigger', to: 'build' },
  ],
};

describe('normalizeWorkflow', () => {
  it('把卡片宽度补到能容纳 8px sublabel，并统一同 lane 高度', () => {
    const result = normalizeWorkflow(WORKFLOW);
    expect(result.applied).toBe(true);
    const nodes = (result.ir.nodes as Array<Record<string, unknown>>).map((node) => ({
      id: node.id as string,
      width: node.width as number,
      height: node.height as number,
    }));
    expect(nodes.find((node) => node.id === 'trigger')).toEqual({ id: 'trigger', width: 120, height: 68 });
    expect(nodes.every((node) => node.height === 68)).toBe(true);
  });
});

describe('lintLayout workflow', () => {
  it('能发现 7px sublabel 与同泳道 8px 顶部差', () => {
    const report = lintLayout('workflow', WORKFLOW, {
      viewBox: [847, 660],
      nodes: [
        { id: 'commit', lane: 'dev', label: '提交代码', x: 48, y: 86, width: 92, height: 68 },
        { id: 'trigger', lane: 'ci', label: '触发流水线', x: 168, y: 220, width: 92, height: 52 },
        { id: 'build', lane: 'ci', label: '构建与测试', x: 316.4, y: 212, width: 136, height: 68 },
      ],
      edges: [
        { from: 'commit', to: 'trigger', points: [[94, 154], [94, 180], [214, 180], [214, 220]] },
        { from: 'trigger', to: 'build', points: [[260, 246], [316.4, 246]] },
      ],
      labels: [],
    });
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('layout/text-fit');
    expect(codes).toContain('layout/lane-alignment');
  });
});
