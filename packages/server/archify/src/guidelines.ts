import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchifyType } from '@aidocs/contracts';
import { archifyRoot } from './run';
import { ArchifyError } from './types';

interface TypeKit {
  summary: string;
  skeleton: Record<string, unknown>;
  notes: string[];
}

const COMPONENT_TYPES = 'frontend / backend / database / cloud / security / messagebus / external';
const VARIANTS = 'default / emphasis / security / dashed';

const KITS: Record<ArchifyType, TypeKit> = {
  architecture: {
    summary: '组件 + 边界 + 连接；适合服务拓扑、部署架构、云/安全网络。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '示例架构', output: 'example.html' },
      components: [
        { id: 'entry', type: 'frontend', label: '入口', sublabel: '浏览器', pos: [40, 80], size: [140, 64] },
        { id: 'api', type: 'backend', label: 'API', sublabel: '服务', pos: [260, 80], size: [140, 64] },
      ],
      connections: [{ id: 'entry-api', from: 'entry', to: 'api', label: 'HTTPS' }],
    },
    notes: [
      `components[].type: ${COMPONENT_TYPES}`,
      'components 必需 id/type/label；pos=[x,y] 与 size=[w,h] 显式给出时布局最可控。',
      '先定主路径的阅读顺序：主路径相邻节点共享行/列，只留 0–1 个折点；分支再摆到主路径上/下/右。',
      'store（database/messagebus）放在读写它的服务正下方；auth/security 放在被校验节点上方；每侧 fan-out k 条关系至少留 32+14×(k−1)px。',
      '新图优先用 layout:{mode:"grid",cols,cellW,cellH,gapX,gapY,origin} + components[].row/col，并给所有组件同一个 size（如 150×66）；grid 只算坐标，不自动排图。',
      '水平间隔按标签宽度预算：6.5×文本单位+21px（CJK 记 2 个单位）；画布不超过 1240px；不确定时省略 meta.viewBox。',
      'connections 必需 from/to；label 是语义关系；variant: ' + VARIANTS,
      'boundaries 可选：{kind,label,wraps:[id]}；有 boundaries 时不要依赖自动排版，手工把成员摆紧。',
      'cards 可选：{dot,title,items[]}，只在交互版显示，海报不含。',
    ],
  },
  workflow: {
    summary: '泳道 + 阶段 + 节点 + 有向边；适合审批、runbook、agent 工具调用。',
    skeleton: {
      schema_version: 2,
      diagram_type: 'workflow',
      meta: { title: '示例流程', output: 'example.html' },
      lanes: [{ id: 'user', label: '用户' }, { id: 'system', label: '系统' }],
      nodes: [
        { id: 'start', lane: 'user', col: 0, type: 'frontend', label: '发起' },
        { id: 'handle', lane: 'system', col: 1, type: 'backend', label: '处理' },
      ],
      edges: [{ from: 'start', to: 'handle', label: '提交' }],
    },
    notes: [
      'lanes 必需 id/label；nodes 必需 id/lane/col/type/label；edges 必需 from/to。',
      'col 是从 0 开始的列号；同 lane 的节点按 col 排布。',
      `nodes[].type: ${COMPONENT_TYPES}`,
      '同 lane 的节点 height/tag 要一致（要么都 68 高，要么都 52）；否则引擎垂直居中会让卡片上下不齐。',
      'sublabel 宽度预算 5.4×文本单位+8px；width 不够就显式给 width（如 120/140），不要等引擎把字号压到 7px。',
      'edges[].variant: default/emphasis/security/dashed；role: main/branch/async/return/error。',
      'phases/groups/mainPath 可选；复杂流程用 phases 标阶段、mainPath 标主路径。',
      '如果设置了 meta.viewBox：节点要给显式 width/height，否则绝对几何会触发 text-fit 诊断；不确定时先不要设 viewBox。',
      'route 先留空让自动路由；return-left/bottom-channel 等预设容易在复杂回边冲突。',
    ],
  },
  sequence: {
    summary: '参与者 + 消息 + 激活条；适合请求时序、缓存未命中、重试。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'sequence',
      meta: { title: '示例时序', output: 'example.html' },
      participants: [
        { id: 'client', type: 'frontend', label: '客户端' },
        { id: 'api', type: 'backend', label: 'API' },
      ],
      messages: [{ from: 'client', to: 'api', y: 180, label: 'GET /' }],
    },
    notes: [
      `participants 必需 id/type/label；type: ${COMPONENT_TYPES}`,
      'messages 必需 from/to/y/label；y 是垂直累加偏移，不是屏幕绝对坐标。',
      'messages[].variant: default/emphasis/security/dashed/return；返回消息用 return。',
      'activations 可选：{participant,from,to,type}；segments 可选。',
    ],
  },
  dataflow: {
    summary: '阶段 + 节点 + 数据流；适合 ETL、分析管线、数据消费链路。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'dataflow',
      meta: { title: '示例数据流', output: 'example.html' },
      stages: [{ label: '采集' }, { label: '处理' }],
      nodes: [
        { id: 'source', type: 'external', label: '事件源', stage: 0, row: 0 },
        { id: 'sink', type: 'database', label: '数仓', stage: 1, row: 0 },
      ],
      flows: [{ from: 'source', to: 'sink', label: '批量写入' }],
    },
    notes: [
      'stages 必需 label；nodes 必需 id/type/label/stage/row；flows 必需 from/to/label。',
      'stage 是 stages 数组的 0-based 索引；row 从 0 开始。',
      `nodes[].type: ${COMPONENT_TYPES}`,
      'flows[].variant/classification 可选；需要通道时用 channelX/channelY。',
    ],
  },
  lifecycle: {
    summary: '状态 + 迁移 + 主路径；适合任务生命周期、重试、终止状态。',
    skeleton: {
      schema_version: 3,
      diagram_type: 'lifecycle',
      meta: { title: '示例状态', output: 'example.html' },
      mainPath: ['idle', 'running', 'done'],
      states: [
        { id: 'idle', type: 'start', label: '待命' },
        { id: 'running', type: 'active', label: '执行中' },
        { id: 'done', type: 'success', label: '完成' },
      ],
      transitions: [
        { from: 'idle', to: 'running', label: '开始' },
        { from: 'running', to: 'done', label: '成功' },
      ],
    },
    notes: [
      'states 必需 id/type/label；type: start/active/waiting/decision/success/failure/neutral/external。',
      'transitions 必需 from/to；label/note 可选。',
      'mainPath 是状态 id 数组，决定主视觉路径。',
    ],
  },
  erd: {
    summary: '实体 + 属性 + 关系；适合数据库 schema。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'erd',
      meta: { title: '示例 ERD', output: 'example.html' },
      entities: [
        { id: 'user', label: 'User', pos: [40, 40], width: 220, attributes: [{ name: 'id', type: 'uuid', key: 'pk' }] },
        { id: 'order', label: 'Order', pos: [320, 40], width: 220, attributes: [{ name: 'id', type: 'uuid', key: 'pk' }] },
      ],
      relationships: [{ from: 'user', to: 'order', fromCardinality: 'one', toCardinality: 'many' }],
    },
    notes: [
      'entities 必需 id/label；attributes 可选，name 必需，key: pk/fk/uk。',
      'relationships 必需 from/to/fromCardinality/toCardinality（one/many）。',
      '关系 label、fromOptional/toOptional、identifying 可选。',
    ],
  },
  class: {
    summary: '类型 + 成员 + 关系；适合类/接口/模块契约。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'class',
      meta: { title: '示例类图', output: 'example.html' },
      types: [
        {
          id: 'Repo',
          label: 'Repo',
          kind: 'interface',
          pos: [40, 40],
          width: 240,
          methods: [{ name: 'find', returns: 'Entity' }],
        },
      ],
    },
    notes: [
      'types 必需 id/label/kind；kind: class/abstract/interface/enum/record。',
      'types[].attributes/methods 可选；relationships 可选，kind: dependency/association/inheritance/realization/composition/aggregation。',
      'layout.gapY 默认 84；同列类型较高（>140px）时用 50–60，能明显收紧竖向空洞。',
    ],
  },
  tree: {
    summary: '父子层级；适合模块树、组织结构、分类树。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'tree',
      meta: { title: '示例树', output: 'example.html' },
      nodes: [
        { id: 'root', label: '根' },
        { id: 'child', label: '子节点', parent: 'root' },
      ],
    },
    notes: [
      'nodes 必需 id/label；parent 指向父节点 id，根节点省略 parent。',
      'layout.direction 可用 down（默认）或 right（深树）。',
    ],
  },
  timeline: {
    summary: '时间点 + 事件 + 可选泳道；适合事故/发布/里程碑。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'timeline',
      meta: {
        title: '示例时间线',
        output: 'example.html',
        evidence: 'illustrative',
        timezone: 'Asia/Shanghai',
      },
      events: [
        { id: 'e1', at: '2026-01-01T09:00:00+08:00', title: '开始' },
        { id: 'e2', at: '2026-01-01T10:00:00+08:00', title: '完成', kind: 'action' },
      ],
    },
    notes: [
      'meta.evidence 必填：observed（真实观测）或 illustrative（示意）。',
      'events 必需 id/at/title；at 必须带 Z 或 ±HH:MM 时区。',
      'kind: default/change/alert/action/recovery；lanes 可选。',
    ],
  },
  waterfall: {
    summary: '时间跨度 + 父子 span；适合请求耗时、agent run、性能分解。',
    skeleton: {
      schema_version: 1,
      diagram_type: 'waterfall',
      meta: { title: '示例瀑布', output: 'example.html', evidence: 'illustrative', unit: 'ms' },
      spans: [
        { id: 'root', name: '请求', start: 0, end: 120 },
        { id: 'db', name: '数据库', start: 20, end: 80, parent: 'root' },
      ],
    },
    notes: [
      'meta.evidence 必填：measured（实测）或 illustrative（示意）。',
      'spans 必需 id/name/start；end/duration 至少给一个；parent 可选。',
      'status: ok/error/cancelled/incomplete；unit 描述时间单位。',
    ],
  },
};

const COMMON = `# Archify 使用约定
- 只输出 JSON IR，不要 HTML/Markdown；工具会注入 meta.output 并做 schema 校验。
- 结构图优先 Archify；自由插画/数值图表用 SVG 工具。
- 生成后必须用 archify_save 落文件，再在 MAIN.md 单独一行引用返回的海报路径。
- 修改已有图前先 read 对应 assets/diagrams/*.archify.json；基于最新内容做最小修改。
- 默认 light + zh-CN + classic + trace 动画；quality 用 showcase（密集图可改 standard）。
- 不要使用 brand、meta.repository、sources 等需要联网/仓库校验的字段。

# 布局验收（保存前自查）
- architecture：主路径 0–1 折点，分支 ≤2；连线不贴节点（净空 ≥12px）；卡片尺寸统一；画布长宽比 1.2–2.2、宽 ≤1240px。
- workflow：同 lane 顶部对齐；sublabel ≥8px；跨泳道回边尽量走空白通道；标签不压节点。
- 保存后看工具返回的「布局体检」；有 layout/* 提醒就按 fix 改坐标/宽度，不要只改文字。`;

export function archifySkeleton(type: ArchifyType): Record<string, unknown> {
  const kit = KITS[type];
  if (!kit) throw new ArchifyError(`未知 Archify 类型：${type}`, { stage: 'validate' });
  return structuredClone(kit.skeleton);
}

export function buildArchifyKit(type: ArchifyType, full = false): string {
  const kit = KITS[type];
  if (!kit) throw new ArchifyError(`未知 Archify 类型：${type}`, { stage: 'validate' });
  const parts = [
    COMMON,
    `# 类型：${type}`,
    kit.summary,
    '',
    '## 最小 skeleton（可改字段，但 schema 以 vendor 为准）',
    '```json',
    JSON.stringify(kit.skeleton, null, 2),
    '```',
    '',
    '## 关键约束',
    ...kit.notes.map((note) => `- ${note}`),
  ];
  if (full) {
    try {
      const schema = readFileSync(join(archifyRoot(), 'schemas', `${type}.schema.json`), 'utf8');
      parts.push('', '## 完整 schema', '```json', schema.trim(), '```');
    } catch {
      parts.push('', '（完整 schema 读取失败；按 skeleton 与诊断修复）');
    }
  } else {
    parts.push('', '需要完整 schema 时再调用 archify_guidelines 并传 full: true。');
  }
  return parts.join('\n');
}
