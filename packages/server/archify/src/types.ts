import type { ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import type { ArchifyLayoutReceipt, ArchifyLayoutReport } from './layout';

export const ARCHIFY_TYPES: ArchifyType[] = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
  'erd',
  'class',
  'tree',
  'timeline',
  'waterfall',
];

export const ARCHIFY_TYPES_SET = new Set<string>(ARCHIFY_TYPES);

export type ArchifyQuality = 'standard' | 'showcase';

export class ArchifyError extends Error {
  constructor(
    message: string,
    readonly options: {
      stage?: 'validate' | 'render' | 'extract' | 'store' | 'offline';
      diagnostics?: ArchifyDiagnostic[];
      warnings?: string[];
      conflict?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ArchifyError';
  }
}

export interface ArchifyValidation {
  ok: boolean;
  diagnostics: ArchifyDiagnostic[];
  warnings: string[];
  /** 渲染器返回的原始几何 receipt（architecture/workflow） */
  layoutReceipt?: ArchifyLayoutReceipt;
  /** 本地 lint 报告；没有布局报告的类型为 undefined */
  layout?: ArchifyLayoutReport;
}

export interface ArchifySummaryInternal {
  sourcePath: string;
  posterPath: string;
  type: ArchifyType;
  title: string;
  revision: string;
  updatedAt: string;
}

export interface ArchifyArtifacts extends ArchifySummaryInternal {
  htmlPath: string;
  warnings: string[];
  layout?: ArchifyLayoutReport;
}

export interface SaveArchifyOptions {
  type: ArchifyType;
  ir: Record<string, unknown>;
  title?: string;
  /** 已有源 JSON：assets/...archify.json；不传则按标题新建 */
  sourcePath?: string;
  quality?: ArchifyQuality;
  baseRevision?: string;
  force?: boolean;
  /** human 保存记录 marker；ai 工具保存清除 marker */
  actor?: 'human' | 'ai';
  /** 新图默认自动排版；更新已有图默认保留坐标 */
  autoLayout?: boolean;
}
