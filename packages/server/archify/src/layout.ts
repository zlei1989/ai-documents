import type { ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';

/**
 * 布局后处理：确定性排版 + 几何体检。
 *
 * 这一层只做两件事：
 * 1. 把 IR 里的节点/连线摆到可读的坐标上（architecture），或补齐卡片宽度/高度（workflow）；
 * 2. 用渲染器返回的 layout receipt 检查折点、贴边、标签碰撞、字号、画布比例。
 *
 * 不碰 vendor：坐标最终仍由 Archify 渲染器消费，规则集中在这里，便于快照测试。
 */

export type LayoutPoint = [number, number];

export interface LayoutReceiptNode {
  id: string;
  type?: string;
  lane?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutReceiptEdge {
  from: string;
  to: string;
  label?: string;
  points: LayoutPoint[];
}

export interface LayoutReceiptLabel {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArchifyLayoutReceipt {
  contract?: string;
  viewBox?: [number, number];
  columns?: number[];
  components?: Array<Record<string, unknown>>;
  connections?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  labels?: Array<Record<string, unknown>>;
  diagnostics?: ArchifyDiagnostic[];
}

export interface ArchifyLayoutReport {
  score: number;
  summary: string;
  issues: ArchifyDiagnostic[];
}

export interface LayoutNormalization {
  ir: Record<string, unknown>;
  applied: boolean;
  warnings: string[];
}

interface GraphNode {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  tag?: string;
  index: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  index: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const TEXT_FIT_WIDTH_FACTOR = 0.6;
const TEXT_FIT_PADDING = 8;
const CARD_MIN_WIDTH = 150;
const CARD_MAX_WIDTH = 200;
const CARD_HEIGHT_WITH_SUBLABEL = 66;
const CARD_HEIGHT_ONLY_LABEL = 56;
const MIN_GAP_X = 70;
const MAX_GAP_X = 140;
const GAP_Y = 54;
const ORIGIN: LayoutPoint = [40, 40];
const MIN_CLEARANCE = 12;

export function textUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    units += isWideChar(code) ? 2 : 1;
  }
  return Math.max(1, units);
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asPoint(value: unknown): LayoutPoint | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = asNumber(value[0]);
  const y = asNumber(value[1]);
  return x === null || y === null ? null : [x, y];
}

function asPoints(value: unknown): LayoutPoint[] {
  if (!Array.isArray(value)) return [];
  const points: LayoutPoint[] = [];
  for (const item of value) {
    const point = asPoint(item);
    if (!point) return [];
    points.push(point);
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Architecture auto-layout                                            */
/* ------------------------------------------------------------------ */

export function layoutArchitecture(input: Record<string, unknown>): LayoutNormalization {
  if (input.diagram_type !== 'architecture') {
    return { ir: input, applied: false, warnings: ['只有 architecture 支持自动排版。'] };
  }
  const rawComponents = Array.isArray(input.components) ? input.components : [];
  const rawConnections = Array.isArray(input.connections) ? input.connections : [];
  if (rawComponents.length === 0) {
    return { ir: input, applied: false, warnings: ['没有组件，跳过自动排版。'] };
  }
  if (Array.isArray(input.boundaries) && input.boundaries.length > 0) {
    return {
      ir: input,
      applied: false,
      warnings: ['图里有 boundaries，自动排版会破坏分组边界；保留原坐标，改用 grid + row/col 手工排。'],
    };
  }
  if (rawComponents.length > 24) {
    return { ir: input, applied: false, warnings: ['组件超过 24 个，自动排版收益不稳定；保留原坐标。'] };
  }

  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  for (const [index, raw] of rawComponents.entries()) {
    if (!isRecord(raw)) return { ir: input, applied: false, warnings: ['组件不是对象，跳过自动排版。'] };
    const id = asString(raw.id);
    const label = asString(raw.label);
    if (!id || !label || nodeById.has(id)) {
      return { ir: input, applied: false, warnings: ['组件缺少 id/label 或 id 重复，跳过自动排版。'] };
    }
    const node: GraphNode = {
      id,
      type: typeof raw.type === 'string' ? raw.type : 'backend',
      label,
      index,
      ...(asString(raw.sublabel) ? { sublabel: asString(raw.sublabel) } : {}),
      ...(asString(raw.tag) ? { tag: asString(raw.tag) } : {}),
    };
    nodes.push(node);
    nodeById.set(id, node);
  }

  const edges: GraphEdge[] = [];
  for (const [index, raw] of rawConnections.entries()) {
    if (!isRecord(raw)) return { ir: input, applied: false, warnings: ['连线不是对象，跳过自动排版。'] };
    const from = asString(raw.from);
    const to = asString(raw.to);
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) {
      return { ir: input, applied: false, warnings: ['连线端点不存在，跳过自动排版。'] };
    }
    edges.push({
      from,
      to,
      index,
      ...(asString(raw.label) ? { label: asString(raw.label) } : {}),
    });
  }

  if (edges.length === 0) {
    return placeIsolatedComponents(input, nodes);
  }
  if (hasDirectedCycle(nodes, edges)) {
    return {
      ir: input,
      applied: false,
      warnings: ['图里存在环，自动排版容易把回边绕乱；保留原坐标，建议手工摆成回边走廊。'],
    };
  }

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)!.push(edge);
    incoming.get(edge.to)!.push(edge);
  }

  const roots = nodes.filter((node) => incoming.get(node.id)!.length === 0);
  if (roots.length === 0) {
    return { ir: input, applied: false, warnings: ['没有入度为 0 的起点，跳过自动排版。'] };
  }
  const root = [...roots].sort((a, b) => reachableCount(b.id, outgoing) - reachableCount(a.id, outgoing) || a.index - b.index)[0]!;

  const chain = buildMainChain(root.id, nodeById, outgoing);
  const chainIds = new Set(chain.map((node) => node.id));
  const needsRowAbove = chain.some((node) =>
    outgoing.get(node.id)!.some((edge) => {
      const target = nodeById.get(edge.to);
      return (
        target !== undefined &&
        !chainIds.has(target.id) &&
        target.type === 'security' &&
        incoming.get(target.id)!.length === 1 &&
        outgoing.get(target.id)!.length === 0
      );
    }),
  );

  const placement = new Map<string, LayoutPoint>();
  const occupied = new Set<string>();
  const key = (col: number, row: number): string => `${col},${row}`;
  const place = (id: string, col: number, row: number): boolean => {
    if (col < 0 || row < 0 || occupied.has(key(col, row)) || placement.has(id)) return false;
    placement.set(id, [col, row]);
    occupied.add(key(col, row));
    return true;
  };

  const horizontalCount = chain.length <= 2
    ? chain.length
    : Math.min(4, Math.max(2, Math.ceil(chain.length * 0.6)));
  const verticalCount = Math.max(0, chain.length - horizontalCount);
  const baseRow = needsRowAbove ? 1 : 0;

  for (let index = 0; index < horizontalCount; index += 1) {
    place(chain[index]!.id, index, baseRow);
  }
  for (let index = 0; index < verticalCount; index += 1) {
    place(chain[horizontalCount + index]!.id, horizontalCount - 1, baseRow + 1 + index);
  }

  // 从已放置节点出发，按连接顺序把分支接到父节点旁边。
  const queue: string[] = [];
  for (const node of nodes) {
    if (placement.has(node.id)) queue.push(node.id);
  }
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const edge of outgoing.get(parentId) ?? []) {
      if (placement.has(edge.to)) continue;
      const parent = placement.get(parentId)!;
      const child = nodeById.get(edge.to)!;
      const preferred = preferredDirection(child, incoming, outgoing);
      const cell = findFreeCell(parent, preferred, occupied);
      if (!cell) continue;
      place(child.id, cell[0], cell[1]);
      queue.push(child.id);
    }
  }

  // 若还有节点没接上（多个根/断开的子图），按行补在下方。
  let extraRow = 0;
  for (const point of placement.values()) extraRow = Math.max(extraRow, point[1] + 1);
  for (const node of nodes) {
    if (placement.has(node.id)) continue;
    const preferred = preferredDirection(node, incoming, outgoing);
    let placed = false;
    const startCol = preferred === 'left' ? 0 : 0;
    for (let row = extraRow; row < extraRow + nodes.length + 2 && !placed; row += 1) {
      for (let col = startCol; col < 8 && !placed; col += 1) {
        if (place(node.id, col, row)) placed = true;
      }
    }
  }
  if (placement.size !== nodes.length) {
    return { ir: input, applied: false, warnings: ['自动排版未能放置全部组件，保留原坐标。'] };
  }

  const cardWidth = roundTo(
    Math.min(
      CARD_MAX_WIDTH,
      Math.max(
        CARD_MIN_WIDTH,
        ...nodes.map((node) => {
          const labelWidth = textUnits(node.label) * TEXT_FIT_WIDTH_FACTOR * 11 + TEXT_FIT_PADDING;
          const sublabelWidth = node.sublabel
            ? textUnits(node.sublabel) * TEXT_FIT_WIDTH_FACTOR * 9 + TEXT_FIT_PADDING
            : 0;
          return Math.max(labelWidth, sublabelWidth);
        }),
      ),
    ),
    10,
  );
  const cardHeight = nodes.some((node) => node.sublabel || node.tag)
    ? CARD_HEIGHT_WITH_SUBLABEL
    : CARD_HEIGHT_ONLY_LABEL;
  const maxHorizontalLabel = edges.reduce((max, edge) => {
    if (!edge.label) return max;
    return Math.max(max, Math.round(textUnits(edge.label) * TEXT_FIT_WIDTH_FACTOR * 8 + 12));
  }, 0);
  const gapX = Math.min(MAX_GAP_X, Math.max(MIN_GAP_X, maxHorizontalLabel));

  const cloned = structuredClone(input) as Record<string, unknown>;
  const clonedComponents = Array.isArray(cloned.components) ? cloned.components : [];
  const componentById = new Map<string, Record<string, unknown>>();
  for (const raw of clonedComponents) {
    if (isRecord(raw) && typeof raw.id === 'string') componentById.set(raw.id, raw);
  }
  for (const node of nodes) {
    const raw = componentById.get(node.id);
    const cell = placement.get(node.id)!;
    if (!raw) continue;
    raw.pos = [
      ORIGIN[0] + cell[0] * (cardWidth + gapX),
      ORIGIN[1] + cell[1] * (cardHeight + GAP_Y),
    ];
    raw.size = [cardWidth, cardHeight];
    delete raw.row;
    delete raw.col;
  }

  // 旧坐标下钉死的端口/折点/标签位置，重排后一律失效。
  stripConnectionPins(cloned);
  delete cloned.layout;
  if (isRecord(cloned.meta)) {
    delete (cloned.meta as Record<string, unknown>).viewBox;
  }

  return {
    ir: cloned,
    applied: true,
    warnings: [
      `已自动排版：${nodes.length} 个组件、${edges.length} 条连线；卡片统一 ${cardWidth}×${cardHeight}，列距 ${gapX}，行距 ${GAP_Y}。`,
    ],
  };
}

function stripConnectionPins(ir: Record<string, unknown>): void {
  const connections = Array.isArray(ir.connections) ? ir.connections : [];
  for (const raw of connections) {
    if (!isRecord(raw)) continue;
    delete raw.fromSide;
    delete raw.toSide;
    delete raw.via;
    delete raw.labelAt;
    delete raw.labelDx;
    delete raw.labelDy;
    delete raw.labelSegment;
    delete raw.route;
  }
}

/** 自动排版不适用（环/boundaries/多根）时的兜底：只保证组件不重叠、有合法坐标 */
export function gridPlaceArchitecture(input: Record<string, unknown>): LayoutNormalization {
  if (input.diagram_type !== 'architecture') {
    return { ir: input, applied: false, warnings: ['只有 architecture 支持网格兜底。'] };
  }
  const rawComponents = Array.isArray(input.components) ? input.components : [];
  if (rawComponents.length === 0) return { ir: input, applied: false, warnings: ['没有组件，跳过网格兜底。'] };
  const nodes: GraphNode[] = [];
  for (const [index, raw] of rawComponents.entries()) {
    if (!isRecord(raw)) return { ir: input, applied: false, warnings: ['组件不是对象，跳过网格兜底。'] };
    const id = asString(raw.id);
    const label = asString(raw.label);
    if (!id || !label) return { ir: input, applied: false, warnings: ['组件缺少 id/label，跳过网格兜底。'] };
    nodes.push({
      id,
      type: typeof raw.type === 'string' ? raw.type : 'backend',
      label,
      index,
      ...(asString(raw.sublabel) ? { sublabel: asString(raw.sublabel) } : {}),
      ...(asString(raw.tag) ? { tag: asString(raw.tag) } : {}),
    });
  }
  const result = placeIsolatedComponents(input, nodes);
  if (!result.applied) return result;
  stripConnectionPins(result.ir);
  return {
    ...result,
    warnings: [...result.warnings, '自动排版未应用，已退回网格兜底；这只保证不重叠，连线质量仍需人工检查。'],
  };
}

function placeIsolatedComponents(input: Record<string, unknown>, nodes: GraphNode[]): LayoutNormalization {
  const cloned = structuredClone(input) as Record<string, unknown>;
  const cols = Math.min(4, Math.max(1, nodes.length));
  const cardWidth = CARD_MIN_WIDTH;
  const cardHeight = nodes.some((node) => node.sublabel || node.tag) ? CARD_HEIGHT_WITH_SUBLABEL : CARD_HEIGHT_ONLY_LABEL;
  const components = Array.isArray(cloned.components) ? cloned.components : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of components) {
    if (isRecord(raw) && typeof raw.id === 'string') byId.set(raw.id, raw);
  }
  for (const [index, node] of nodes.entries()) {
    const raw = byId.get(node.id);
    if (!raw) continue;
    raw.pos = [ORIGIN[0] + (index % cols) * (cardWidth + MIN_GAP_X), ORIGIN[1] + Math.floor(index / cols) * (cardHeight + GAP_Y)];
    raw.size = [cardWidth, cardHeight];
    delete raw.row;
    delete raw.col;
  }
  delete cloned.layout;
  if (isRecord(cloned.meta)) delete (cloned.meta as Record<string, unknown>).viewBox;
  return { ir: cloned, applied: true, warnings: [`已按网格摆放 ${nodes.length} 个组件。`] };
}

function buildMainChain(rootId: string, nodeById: Map<string, GraphNode>, outgoing: Map<string, GraphEdge[]>): GraphNode[] {
  const chain: GraphNode[] = [nodeById.get(rootId)!];
  const visited = new Set([rootId]);
  let current = rootId;
  while (true) {
    const candidates = (outgoing.get(current) ?? []).filter((edge) => !visited.has(edge.to));
    if (candidates.length === 0) break;
    const scored = candidates
      .map((edge) => {
        const target = nodeById.get(edge.to)!;
        const downstream = (outgoing.get(edge.to) ?? []).filter((next) => !visited.has(next.to)).length;
        const typePenalty =
          target.type === 'security' ? 3 : target.type === 'database' || target.type === 'messagebus' ? 2 : 0;
        const sinkPenalty = downstream === 0 ? 10 : 0;
        return { edge, score: downstream * 2 - typePenalty - sinkPenalty };
      })
      .sort((a, b) => b.score - a.score || a.edge.index - b.edge.index);
    const next = scored[0]!.edge;
    chain.push(nodeById.get(next.to)!);
    visited.add(next.to);
    current = next.to;
  }
  return chain;
}

function reachableCount(start: string, outgoing: Map<string, GraphEdge[]>): number {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      stack.push(edge.to);
    }
  }
  return seen.size;
}

function hasDirectedCycle(nodes: GraphNode[], edges: GraphEdge[]): boolean {
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) outgoing.get(edge.from)!.push(edge.to);
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const node of nodes) {
    if (visit(node.id)) return true;
  }
  return false;
}

function preferredDirection(
  node: GraphNode,
  incoming: Map<string, GraphEdge[]>,
  outgoing: Map<string, GraphEdge[]>,
): 'right' | 'left' | 'up' | 'down' {
  const isSink = (outgoing.get(node.id) ?? []).length === 0;
  const isSingleParent = (incoming.get(node.id) ?? []).length === 1;
  if (isSink && isSingleParent && node.type === 'security') return 'up';
  if (isSink && isSingleParent && (node.type === 'database' || node.type === 'messagebus')) return 'down';
  return 'right';
}

function findFreeCell(
  parent: LayoutPoint,
  preferred: 'right' | 'left' | 'up' | 'down',
  occupied: Set<string>,
): LayoutPoint | null {
  const [col, row] = parent;
  const candidates: LayoutPoint[] =
    preferred === 'up'
      ? [[col, row - 1], [col, row + 1], [col + 1, row], [col - 1, row]]
      : preferred === 'down'
        ? [[col, row + 1], [col + 1, row], [col, row - 1], [col - 1, row]]
        : preferred === 'left'
          ? [[col - 1, row], [col, row + 1], [col, row - 1], [col + 1, row]]
          : [[col + 1, row], [col, row + 1], [col, row - 1], [col - 1, row], [col + 1, row + 1], [col + 1, row - 1]];
  for (const candidate of candidates) {
    if (candidate[0] < 0 || candidate[1] < 0) continue;
    if (!occupied.has(`${candidate[0]},${candidate[1]}`)) return candidate;
  }
  // 周边都被占了，向右扩一列。
  let nextCol = 0;
  for (const cell of occupied) {
    const [c] = cell.split(',').map(Number);
    nextCol = Math.max(nextCol, c ?? 0);
  }
  return [nextCol + 1, row];
}

/* ------------------------------------------------------------------ */
/* Workflow card normalization                                         */
/* ------------------------------------------------------------------ */

export function normalizeWorkflow(input: Record<string, unknown>): LayoutNormalization {
  if (input.diagram_type !== 'workflow') {
    return { ir: input, applied: false, warnings: ['只有 workflow 支持卡片规范化。'] };
  }
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (rawNodes.length === 0) return { ir: input, applied: false, warnings: ['没有节点，跳过卡片规范化。'] };

  const cloned = structuredClone(input) as Record<string, unknown>;
  const clonedNodes = Array.isArray(cloned.nodes) ? cloned.nodes.filter(isRecord) : [];
  const laneHasTag = new Set<string>();
  for (const node of rawNodes) {
    if (!isRecord(node)) continue;
    if (typeof node.lane === 'string' && asString(node.tag)) laneHasTag.add(node.lane);
  }

  let changed = 0;
  for (const node of clonedNodes) {
    if (!isRecord(node)) continue;
    const label = asString(node.label) ?? '';
    const sublabel = asString(node.sublabel);
    const tag = asString(node.tag);
    const labelWidth = textUnits(label) * TEXT_FIT_WIDTH_FACTOR * 11 + TEXT_FIT_PADDING;
    const sublabelWidth = sublabel ? textUnits(sublabel) * TEXT_FIT_WIDTH_FACTOR * 8 + TEXT_FIT_PADDING : 0;
    const tagWidth = tag ? textUnits(tag) * TEXT_FIT_WIDTH_FACTOR * 7 + TEXT_FIT_PADDING : 0;
    const needed = Math.max(120, labelWidth, sublabelWidth, tagWidth);
    const currentWidth = asNumber(node.width);
    if (currentWidth === null || currentWidth < needed) {
      node.width = Math.min(200, Math.ceil(needed / 10) * 10);
      changed += 1;
    }
    const lane = typeof node.lane === 'string' ? node.lane : '';
    const targetHeight = laneHasTag.has(lane) || tag ? 68 : 52;
    const currentHeight = asNumber(node.height);
    if (currentHeight === null || (tag !== undefined && currentHeight < 68)) {
      node.height = targetHeight;
      changed += 1;
    }
  }

  if (changed === 0) {
    return { ir: input, applied: false, warnings: [] };
  }
  const clonedEdges = Array.isArray(cloned.edges) ? cloned.edges : [];
  for (const edge of clonedEdges) {
    if (!isRecord(edge)) continue;
    delete edge.via;
    delete edge.labelAt;
    delete edge.channelX;
    delete edge.channelY;
  }
  if (isRecord(cloned.meta)) delete (cloned.meta as Record<string, unknown>).viewBox;
  return {
    ir: cloned,
    applied: true,
    warnings: [
      `已补齐 ${changed} 处卡片尺寸，并移除旧 viewBox/绝对路由钉点；跨泳道路由仍由编译器决定。`,
    ],
  };
}

export function normalizeDiagramLayout(type: ArchifyType, input: Record<string, unknown>): LayoutNormalization {
  if (type === 'architecture') return layoutArchitecture(input);
  if (type === 'workflow') return normalizeWorkflow(input);
  return { ir: input, applied: false, warnings: [`${type} 暂不支持自动排版；请用 JSON/结构表手工调整。`] };
}

/* ------------------------------------------------------------------ */
/* Layout lint                                                         */
/* ------------------------------------------------------------------ */

interface NormalizedReceipt {
  viewBox: [number, number] | null;
  nodes: Array<LayoutReceiptNode & { lane?: string }>;
  edges: LayoutReceiptEdge[];
  labels: LayoutReceiptLabel[];
}

export function lintLayout(
  type: ArchifyType,
  ir: Record<string, unknown>,
  receipt: ArchifyLayoutReceipt | null | undefined,
): ArchifyLayoutReport {
  if (!receipt) return { score: 100, summary: '布局 100 分：该类型没有布局报告。', issues: [] };
  const normalized = normalizeReceipt(type, receipt);
  if (!normalized) return { score: 100, summary: '布局 100 分：布局报告为空。', issues: [] };
  const issues: ArchifyDiagnostic[] = [];
  const push = (
    code: string,
    message: string,
    subject: Record<string, unknown>,
    evidence: Record<string, unknown>,
    supportedFixes: string[],
  ): void => {
    if (issues.some((issue) => issue.code === code && JSON.stringify(issue.subject) === JSON.stringify(subject))) return;
    issues.push({ code, severity: 'warning', message, subject, evidence, supportedFixes });
  };

  const { viewBox, nodes, edges, labels } = normalized;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let totalBends = 0;
  const bendThreshold = type === 'workflow' ? 3 : 2;
  let longEdgeCount = 0;
  const edgeLengths: number[] = [];

  for (const edge of edges) {
    const bends = bendCount(edge.points);
    const length = polylineLength(edge.points);
    totalBends += bends;
    edgeLengths.push(length);
    const edgeName = `${edge.from}→${edge.to}`;
    if (bends > bendThreshold) {
      push(
        'layout/edge-bends',
        `连线 ${edgeName} 有 ${bends} 个折点（${Math.round(length)}px）；把端点移到同一行/列，或把 store 放到 owner 正下方，可降到 ≤1 个折点。`,
        { edge: { from: edge.from, to: edge.to } },
        { bends, length: Math.round(length), threshold: bendThreshold },
        ['调整节点坐标，让相邻节点共享行/列', '把数据库/缓存放在读它的服务正下方'],
      );
    }
    for (const node of nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      const clearance = minClearance(edge.points, node);
      if (clearance < MIN_CLEARANCE) {
        push(
          'layout/clearance',
          `连线 ${edgeName} 距 ${node.id} 仅 ${clearance.toFixed(1)}px（建议 ≥${MIN_CLEARANCE}px）；这是一条贴着节点走的绕行线。`,
          { edge: { from: edge.from, to: edge.to }, node: node.id },
          { clearance: Number(clearance.toFixed(1)), threshold: MIN_CLEARANCE },
          ['把被绕过的节点移开，或缩短这条连线', '把 store 放到 owner 正下方'],
        );
      }
    }
  }

  if (edges.length > 0 && totalBends > edges.length) {
    push(
      'layout/bend-density',
      `连线共 ${totalBends} 个折点（${edges.length} 条边，平均 ${(totalBends / edges.length).toFixed(1)} 个/条）；当前布局让自动路由频繁拐弯。`,
      {},
      { totalBends, edges: edges.length },
      ['把主路径节点排成一条直线/一个 L 形', '把同层节点对齐到行列网格'],
    );
  }

  if (edgeLengths.length >= 4) {
    const sorted = [...edgeLengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    for (const edge of edges) {
      const length = polylineLength(edge.points);
      if (length > 300 && median > 0 && length > median * 2.5) {
        longEdgeCount += 1;
        push(
          'layout/long-edge',
          `连线 ${edge.from}→${edge.to} 长 ${Math.round(length)}px，是同类连线中位数的 ${(length / median).toFixed(1)} 倍；端点离得太远。`,
          { edge: { from: edge.from, to: edge.to } },
          { length: Math.round(length), median: Math.round(median) },
          ['把目标节点移到源节点附近', '调整主路径，让相邻关系共享行/列'],
        );
      }
    }
  }

  let crossingCount = 0;
  const crossingPairs: Array<[LayoutReceiptEdge, LayoutReceiptEdge]> = [];
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const left = edges[i]!;
      const right = edges[j]!;
      if (sharesEndpoint(left, right)) continue;
      let crossed = false;
      for (const [a, b] of segmentsOf(left.points)) {
        for (const [c, d] of segmentsOf(right.points)) {
          if (properCross(a, b, c, d)) {
            crossed = true;
            break;
          }
        }
        if (crossed) break;
      }
      if (crossed) {
        crossingCount += 1;
        crossingPairs.push([left, right]);
      }
    }
  }
  if (crossingCount > 0) {
    const examples = crossingPairs
      .slice(0, 3)
      .map(([left, right]) => `${left.from}→${left.to} 与 ${right.from}→${right.to}`)
      .join('、');
    push(
      'layout/edge-crossing',
      `有 ${crossingCount} 处连线交叉（${examples}）；优先移动非主路径端点，或把分支放到主路径另一侧。`,
      { edges: crossingPairs.slice(0, 3).map(([left, right]) => [left.from, left.to, right.from, right.to]) },
      { crossings: crossingCount },
      ['把分支节点移到主路径的另一侧', '把 store 放到 owner 正下方'],
    );
  }

  for (const label of labels) {
    const rect = labelRect(label);
    for (const node of nodes) {
      if (rectOverlap(rect, node) > 0) {
        push(
          'layout/label-node',
          `标签「${label.text}」与节点 ${node.id} 重叠；把节点移开或给标签留出 ${MIN_CLEARANCE}px 以上空隙。`,
          { label: label.text, node: node.id },
          { overlap: Number(rectOverlap(rect, node).toFixed(1)) },
          ['移动标签所在连线的端点', '缩短标签文字'],
        );
      }
    }
  }

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const left = labels[i]!;
      const right = labels[j]!;
      if (rectOverlap(labelRect(left), labelRect(right)) > 0) {
        push(
          'layout/label-label',
          `标签「${left.text}」与「${right.text}」重叠；两条边的标签需要错开。`,
          { labels: [left.text, right.text] },
          {},
          ['移动其中一条连线的端点', '缩短标签文字'],
        );
      }
    }
  }

  if (type === 'workflow') {
    lintWorkflowTypography(ir, nodes, push);
  } else {
    lintNodeTypography(nodes, push);
  }

  if (viewBox) {
    const [width, height] = viewBox;
    const aspect = width / height;
    // 2–3 个节点的图天然偏宽，不把比例当缺陷；只看有足够内容的图。
    if (nodes.length >= 4 && (aspect < 1.1 || aspect > 2.4)) {
      push(
        'layout/canvas-aspect',
        `画布 ${width}×${height}（${aspect.toFixed(2)}:1）偏${aspect > 2.4 ? '扁' : '窄'}；建议控制在 1.2–2.2，避免整张图被压成一条横带或一根竖条。`,
        {},
        { width, height, aspect: Number(aspect.toFixed(2)) },
        ['把长链折成 L 形/蛇形', '把 store 放到 owner 正下方'],
      );
    }
    if (width > 1240) {
      push(
        'layout/canvas-width',
        `画布宽 ${width}px，超过 1240px 的可读上限；在桌面宽度下 8px 标签会被压到可读线以下。`,
        {},
        { width },
        ['减少列数，把长链折行', '缩短标签'],
      );
    }
  }

  if (type === 'architecture') {
    const widths = new Set(nodes.map((node) => Math.round(node.width)));
    const heights = new Set(nodes.map((node) => Math.round(node.height)));
    if (widths.size > 2 || heights.size > 1) {
      push(
        'layout/card-uniformity',
        `卡片尺寸不统一（宽 ${[...widths].join('/')}，高 ${[...heights].join('/')}）；同层卡片建议统一宽高。`,
        {},
        { widths: [...widths], heights: [...heights] },
        ['用 layout:grid + 统一 size', '点「排版」重排'],
      );
    }
  }

  const score = Math.max(0, Math.min(100, 100 - scoreDeduction(issues, crossingCount, longEdgeCount)));
  const summary = issues.length === 0
    ? '布局 100 分：未发现明显的折点、贴边、碰撞或字号问题'
    : summarizeIssues(issues, score);
  return { score, summary, issues };
}

function normalizeReceipt(type: ArchifyType, receipt: ArchifyLayoutReceipt): NormalizedReceipt | null {
  const viewBox = Array.isArray(receipt.viewBox) && receipt.viewBox.length >= 2
    ? [Number(receipt.viewBox[0]), Number(receipt.viewBox[1])] as [number, number]
    : null;
  const nodes: Array<LayoutReceiptNode & { lane?: string }> = [];
  const edges: LayoutReceiptEdge[] = [];
  const labels: LayoutReceiptLabel[] = [];

  if (type === 'architecture') {
    for (const raw of receipt.components ?? []) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id);
      const x = asNumber(raw.x);
      const y = asNumber(raw.y);
      const width = asNumber(raw.width);
      const height = asNumber(raw.height);
      if (!id || x === null || y === null || width === null || height === null) continue;
      nodes.push({ id, type: asString(raw.type), label: asString(raw.label), x, y, width, height });
    }
    for (const raw of receipt.connections ?? []) {
      if (!isRecord(raw)) continue;
      const from = asString(raw.from);
      const to = asString(raw.to);
      const points = asPoints(raw.points);
      if (!from || !to || points.length < 2) continue;
      edges.push({ from, to, points, ...(asString(raw.label) ? { label: asString(raw.label) } : {}) });
    }
    for (const raw of receipt.labels ?? []) {
      if (!isRecord(raw)) continue;
      const text = asString(raw.text) ?? asString(raw.label);
      const x = asNumber(raw.x);
      const y = asNumber(raw.y);
      const width = asNumber(raw.width);
      const height = asNumber(raw.height);
      if (!text || x === null || y === null || width === null || height === null) continue;
      labels.push({ text, x, y, width, height });
    }
  } else {
    for (const raw of receipt.nodes ?? []) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id);
      const x = asNumber(raw.x);
      const y = asNumber(raw.y);
      const width = asNumber(raw.width);
      const height = asNumber(raw.height);
      if (!id || x === null || y === null || width === null || height === null) continue;
      nodes.push({ id, type: asString(raw.type), lane: asString(raw.lane), label: asString(raw.label), x, y, width, height });
    }
    for (const raw of receipt.edges ?? []) {
      if (!isRecord(raw)) continue;
      const from = asString(raw.from);
      const to = asString(raw.to);
      const points = asPoints(raw.points);
      if (!from || !to || points.length < 2) continue;
      edges.push({ from, to, points });
    }
    for (const raw of receipt.labels ?? []) {
      if (!isRecord(raw)) continue;
      const text = asString(raw.label) ?? asString(raw.text);
      const x = asNumber(raw.x);
      const y = asNumber(raw.y);
      const width = asNumber(raw.width);
      const height = asNumber(raw.height);
      if (!text || x === null || y === null || width === null || height === null) continue;
      // Workflow receipt 的 x 是标签中心、y 是基线；换算成左上角。
      labels.push({ text, x: x - width / 2, y: y - (height - 4), width, height });
    }
  }

  if (nodes.length === 0 && edges.length === 0) return null;
  return { viewBox, nodes, edges, labels };
}

function lintNodeTypography(nodes: LayoutReceiptNode[], push: IssuePush): void {
  for (const node of nodes) {
    const label = node.label;
    if (!label) continue;
    const labelUnits = textUnits(label);
    const labelFont = Math.min(11, (node.width - TEXT_FIT_PADDING) / (labelUnits * TEXT_FIT_WIDTH_FACTOR));
    if (labelFont < 9) {
      push(
        'layout/text-fit',
        `节点 ${node.id} 的 label「${label}」在 ${node.width}px 宽内只能排到 ${labelFont.toFixed(1)}px（建议 ≥9px）；把卡片加宽或缩短文字。`,
        { node: node.id },
        { font: Number(labelFont.toFixed(1)), width: node.width, minimum: 9 },
        ['加宽卡片', '缩短 label'],
      );
    }
  }
}

function lintWorkflowTypography(
  ir: Record<string, unknown>,
  nodes: Array<LayoutReceiptNode & { lane?: string }>,
  push: IssuePush,
): void {
  const rawNodes = Array.isArray(ir.nodes) ? ir.nodes.filter(isRecord) : [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const node of rawNodes) {
    if (typeof node.id === 'string') rawById.set(node.id, node);
  }
  for (const node of nodes) {
    const raw = rawById.get(node.id);
    if (!raw) continue;
    const sublabel = asString(raw.sublabel);
    if (sublabel) {
      const font = Math.min(8, (node.width - TEXT_FIT_PADDING) / (textUnits(sublabel) * TEXT_FIT_WIDTH_FACTOR));
      if (font < 8 - 0.05) {
        const needed = Math.ceil((textUnits(sublabel) * 8 * TEXT_FIT_WIDTH_FACTOR + TEXT_FIT_PADDING) / 10) * 10;
        push(
          'layout/text-fit',
          `节点 ${node.id} 的 sublabel「${sublabel}」在 ${node.width}px 宽内被压到 ${font.toFixed(1)}px（建议 ≥8px）；把 width 提到 ≥${needed}px。`,
          { node: node.id },
          { font: Number(font.toFixed(1)), width: node.width, needed, minimum: 8 },
          [`把节点 width 设为 ${needed} 或更大`, '缩短 sublabel'],
        );
      }
    }
  }

  const byLane = new Map<string, Array<LayoutReceiptNode & { lane?: string }>>();
  for (const node of nodes) {
    if (!node.lane) continue;
    const list = byLane.get(node.lane) ?? [];
    list.push(node);
    byLane.set(node.lane, list);
  }
  for (const [lane, list] of byLane) {
    if (list.length < 2) continue;
    const offsets = rawNodes.filter((node) => node.lane === lane).map((node) => asNumber(node.yOffset) ?? 0);
    if (offsets.some((offset) => offset !== 0)) continue;
    const tops = list.map((node) => node.y);
    const spread = Math.max(...tops) - Math.min(...tops);
    if (spread > 1) {
      push(
        'layout/lane-alignment',
        `泳道 ${lane} 的节点顶部相差 ${spread.toFixed(1)}px；同泳道卡片高度不一致时会被垂直居中，建议统一 height/tag。`,
        { lane },
        { spread: Number(spread.toFixed(1)) },
        ['给同泳道节点统一 height', '同泳道要么都有 tag，要么都没有'],
      );
    }
  }
}

type IssuePush = (
  code: string,
  message: string,
  subject: Record<string, unknown>,
  evidence: Record<string, unknown>,
  supportedFixes: string[],
) => void;

function scoreDeduction(issues: ArchifyDiagnostic[], crossingCount: number, longEdgeCount: number): number {
  let deduction = 0;
  for (const issue of issues) {
    switch (issue.code) {
      case 'layout/edge-bends':
        deduction += 6;
        break;
      case 'layout/bend-density':
        deduction += 5;
        break;
      case 'layout/clearance':
        deduction += 8;
        break;
      case 'layout/edge-crossing':
        deduction += 6;
        break;
      case 'layout/long-edge':
        deduction += 5;
        break;
      case 'layout/label-node':
        deduction += 5;
        break;
      case 'layout/label-label':
        deduction += 3;
        break;
      case 'layout/text-fit':
        deduction += 6;
        break;
      case 'layout/lane-alignment':
        deduction += 5;
        break;
      case 'layout/canvas-aspect':
      case 'layout/canvas-width':
        deduction += 8;
        break;
      case 'layout/card-uniformity':
        deduction += 4;
        break;
      default:
        break;
    }
  }
  if (crossingCount > 2) deduction += Math.min(10, crossingCount * 2);
  if (longEdgeCount > 2) deduction += 4;
  return deduction;
}

function summarizeIssues(issues: ArchifyDiagnostic[], score: number): string {
  const parts: string[] = [];
  const count = (code: string): number => issues.filter((issue) => issue.code === code).length;
  const bends = count('layout/edge-bends');
  const clearance = count('layout/clearance');
  const labels = count('layout/label-node');
  const textFit = count('layout/text-fit');
  const alignment = count('layout/lane-alignment');
  const crossings = count('layout/edge-crossing');
  const aspect = count('layout/canvas-aspect');
  const uniformity = count('layout/card-uniformity');
  if (bends > 0) parts.push(`${bends} 条连线折点过多`);
  if (clearance > 0) parts.push(`${clearance} 处 <${MIN_CLEARANCE}px 贴边`);
  if (labels > 0) parts.push(`${labels} 处标签压节点`);
  if (textFit > 0) parts.push(`${textFit} 处字号过小`);
  if (alignment > 0) parts.push(`${alignment} 条泳道上下不齐`);
  if (crossings > 0) parts.push(`${crossings} 处连线交叉`);
  if (aspect > 0) parts.push('画布比例失衡');
  if (uniformity > 0) parts.push('卡片尺寸不统一');
  return `布局 ${score} 分：${parts.length > 0 ? parts.join(' · ') : `${issues.length} 条几何提醒`}`;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function segmentsOf(points: LayoutPoint[]): Array<[LayoutPoint, LayoutPoint]> {
  const segments: Array<[LayoutPoint, LayoutPoint]> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    if (from[0] === to[0] && from[1] === to[1]) continue;
    segments.push([from, to]);
  }
  return segments;
}

function bendCount(points: LayoutPoint[]): number {
  let bends = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const ax = current[0] - previous[0];
    const ay = current[1] - previous[1];
    const bx = next[0] - current[0];
    const by = next[1] - current[1];
    if (ax * by - ay * bx !== 0) bends += 1;
    else if (ax * bx + ay * by < 0) bends += 1;
  }
  return bends;
}

function polylineLength(points: LayoutPoint[]): number {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += Math.abs(points[index + 1]![0] - points[index]![0]) + Math.abs(points[index + 1]![1] - points[index]![1]);
  }
  return length;
}

function pointInRect(point: LayoutPoint, rect: Rect): boolean {
  return point[0] >= rect.x && point[0] <= rect.x + rect.width && point[1] >= rect.y && point[1] <= rect.y + rect.height;
}

function pointSegmentDistance(point: LayoutPoint, from: LayoutPoint, to: LayoutPoint): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - from[0], point[1] - from[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy));
}

function segmentRectDistance(from: LayoutPoint, to: LayoutPoint, rect: Rect): number {
  if (pointInRect(from, rect) || pointInRect(to, rect)) return 0;
  const edges: Array<[LayoutPoint, LayoutPoint]> = [
    [[rect.x, rect.y], [rect.x + rect.width, rect.y]],
    [[rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height]],
    [[rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]],
    [[rect.x, rect.y + rect.height], [rect.x, rect.y]],
  ];
  let minimum = Number.POSITIVE_INFINITY;
  for (const [a, b] of edges) {
    if (segmentsIntersect(from, to, a, b)) return 0;
    minimum = Math.min(
      minimum,
      pointSegmentDistance(from, a, b),
      pointSegmentDistance(to, a, b),
      pointSegmentDistance(a, from, to),
      pointSegmentDistance(b, from, to),
    );
  }
  return minimum;
}

function minClearance(points: LayoutPoint[], node: LayoutReceiptNode): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const [from, to] of segmentsOf(points)) {
    minimum = Math.min(minimum, segmentRectDistance(from, to, node));
  }
  return Number.isFinite(minimum) ? minimum : Number.POSITIVE_INFINITY;
}

function rectOverlap(left: Rect, right: Rect): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function labelRect(label: LayoutReceiptLabel): Rect {
  return { x: label.x, y: label.y, width: label.width, height: label.height };
}

function sharesEndpoint(left: LayoutReceiptEdge, right: LayoutReceiptEdge): boolean {
  return (
    left.from === right.from ||
    left.from === right.to ||
    left.to === right.from ||
    left.to === right.to
  );
}

function orientation(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function properCross(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return (
    ((first > 1e-9 && second < -1e-9) || (first < -1e-9 && second > 1e-9)) &&
    ((third > 1e-9 && fourth < -1e-9) || (third < -1e-9 && fourth > 1e-9))
  );
}

function segmentsIntersect(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): boolean {
  if (properCross(a, b, c, d)) return true;
  const onSegment = (p: LayoutPoint, q: LayoutPoint, r: LayoutPoint): boolean =>
    Math.min(p[0], q[0]) - 1e-9 <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) + 1e-9 &&
    Math.min(p[1], q[1]) - 1e-9 <= r[1] &&
    r[1] <= Math.max(p[1], q[1]) + 1e-9;
  return (
    (Math.abs(orientation(a, b, c)) < 1e-9 && onSegment(a, b, c)) ||
    (Math.abs(orientation(a, b, d)) < 1e-9 && onSegment(a, b, d)) ||
    (Math.abs(orientation(c, d, a)) < 1e-9 && onSegment(c, d, a)) ||
    (Math.abs(orientation(c, d, b)) < 1e-9 && onSegment(c, d, b))
  );
}
