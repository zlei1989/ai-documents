import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ArchifyType } from '@aidocs/contracts';
import {
  ArchifyError,
  ARCHIFY_TYPES,
  buildArchifyKit,
  isArchifyType,
  saveArchify,
  type ArchifyQuality,
} from '@aidocs/archify';
import { diagramMarkdownRef, normalizeAssetPath } from '@aidocs/core';

/**
 * Archify 结构图工具：
 * - archify_guidelines：按类型返回 schema 摘要 + skeleton；
 * - archify_save：校验 IR、渲染 HTML、提取独立 SVG 海报，返回 Markdown 引用。
 *
 * 不引入 bash/MCP：Archify 以 vendored CLI 由 @aidocs/archify 子进程调用。
 */

export const ARCHIFY_TOOL_NAMES = ['archify_guidelines', 'archify_save'] as const;

export interface ArchifyToolOptions {
  artifactDir: string;
}

function parseIr(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') throw new Error('IR 必须是 JSON 对象或 JSON 字符串');
  const text = value.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`IR 不是合法 JSON：${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('IR 必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function diagnosticsText(error: ArchifyError): string {
  const lines: string[] = [error.message];
  const diagnostics = error.options.diagnostics ?? [];
  for (const item of diagnostics.slice(0, 8)) {
    const subject = Object.keys(item.subject ?? {}).length > 0 ? ` ${JSON.stringify(item.subject)}` : '';
    lines.push(`- [${item.code}]${subject} ${item.message}`);
    for (const fix of item.supportedFixes.slice(0, 3)) lines.push(`  fix: ${fix}`);
  }
  if (diagnostics.length > 8) lines.push(`- …还有 ${diagnostics.length - 8} 条诊断`);
  return lines.join('\n');
}

function sourcePathInput(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  const raw = path.trim();
  return raw.startsWith('assets/') ? normalizeAssetPath(raw) : normalizeAssetPath(`assets/${raw}`);
}

export function createArchifyExtension(options: ArchifyToolOptions): ExtensionFactory {
  const guidelinesTool = defineTool({
    name: 'archify_guidelines',
    label: 'Archify 规范',
    description:
      '返回指定 Archify 图类型的 JSON IR 规范：结构数组、必需字段、枚举、最小 skeleton 与布局要点。' +
      '生成或修改图示前可先取对应类型的规范；不生成代码。',
    promptSnippet: '获取图示类型规范（结构数组/字段/骨架/布局要点）',
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: Type.Object({
      type: Type.Union(ARCHIFY_TYPES.map((type) => Type.Literal(type))),
      full: Type.Optional(Type.Boolean({ description: '是否附完整 JSON schema（默认只给紧凑 skeleton）' })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text' as const, text: buildArchifyKit(params.type as ArchifyType, params.full === true) }],
        details: { type: params.type, full: params.full === true },
      };
    },
  });

  const saveTool = defineTool({
    name: 'archify_save',
    label: '生成 Archify 图示',
    description:
      '校验 Archify JSON IR，渲染交互 HTML，提取独立 SVG 海报，写入 assets/diagrams；返回可插入 MAIN.md 的图片引用。' +
      '校验失败返回 diagnostics，不写文件。ir 传 JSON 字符串（整个对象，不带 Markdown 围栏）；更新已有图时 path 传 .archify.json。',
    promptSnippet: '校验并保存 Archify 图示，返回 Markdown 引用',
    promptGuidelines: [
      'Archify IR 必须符合 archify_guidelines 给出的 schema；校验失败按 diagnostics 修复后重试。',
      '生成后把返回的引用单独一行插入 MAIN.md；更新已有图先 read 源 JSON。',
      '新图默认自动排版；更新已有图默认保留坐标。要主动重排就传 autoLayout:true。',
      '保存结果里的「布局体检」是几何建议：折点、<12px 贴边、字号 <8px、同泳道不齐都要按建议修。',
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    parameters: Type.Object({
      type: Type.Union(ARCHIFY_TYPES.map((type) => Type.Literal(type))),
      ir: Type.String({ description: 'Archify JSON IR，整个对象序列化成字符串（不要 Markdown 围栏）' }),
      title: Type.Optional(Type.String({ description: '图题；省略时用 IR.meta.title' })),
      path: Type.Optional(
        Type.String({ description: '更新已有图：assets/diagrams/x.archify.json；不填则按标题新建，同名自动加 -2' }),
      ),
      quality: Type.Optional(
        Type.Union([Type.Literal('standard'), Type.Literal('showcase')], {
          description: '校验质量档位，默认 showcase；密集图可用 standard',
        }),
      ),
      autoLayout: Type.Optional(
        Type.Boolean({ description: '是否自动排版；不填时新图自动排、更新已有图保留坐标' }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!isArchifyType(params.type)) throw new Error(`未知 Archify 类型：${params.type}`);
      let ir: Record<string, unknown>;
      try {
        ir = parseIr(params.ir);
      } catch (error) {
        throw new Error(`archify_save 失败：${(error as Error).message}`);
      }
      const quality = (params.quality ?? 'showcase') as ArchifyQuality;
      const title = params.title?.trim() || (typeof ir.meta === 'object' && ir.meta && typeof (ir.meta as Record<string, unknown>).title === 'string'
        ? String((ir.meta as Record<string, unknown>).title).trim()
        : '图示');
      let sourcePath: string | undefined;
      try {
        sourcePath = sourcePathInput(params.path);
      } catch (error) {
        throw new Error(`archify_save 失败：${(error as Error).message}`);
      }
      try {
        const saved = await saveArchify(options.artifactDir, {
          type: params.type,
          ir,
          title,
          ...(sourcePath ? { sourcePath } : {}),
          quality,
          actor: 'ai',
          ...(params.autoLayout !== undefined ? { autoLayout: params.autoLayout } : {}),
        });
        const markdown = diagramMarkdownRef(saved.title || title, saved.posterPath);
        const layout = saved.layout;
        const layoutMessages = new Set((layout?.issues ?? []).map((issue) => issue.message));
        const extraWarnings = [...new Set(saved.warnings)].filter((warning) => !layoutMessages.has(warning));
        const lines = [
          `已生成 Archify ${saved.type} 图：${saved.sourcePath}`,
          `海报：${saved.posterPath}（${Math.round(Buffer.byteLength(saved.html, 'utf8') / 1024)} KB HTML 缓存，revision ${saved.revision.slice(0, 12)}）。`,
          '在 MAIN.md 里单独一行插入引用：',
          markdown,
          '改这张图请先 read 源 JSON，再用 archify_save 更新；海报 SVG 只读，不要 read 或改它。',
        ];
        if (layout) {
          lines.push('', `布局体检：${layout.summary}`);
          for (const issue of layout.issues.slice(0, 6)) {
            lines.push(`- [${issue.code}] ${issue.message}`);
            const fix = issue.supportedFixes[0];
            if (fix) lines.push(`  fix: ${fix}`);
          }
          if (layout.issues.length > 6) lines.push(`- …还有 ${layout.issues.length - 6} 条布局建议`);
        }
        for (const warning of extraWarnings.slice(0, 4)) lines.push(`- 提醒：${warning}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n'),
            },
          ],
          details: {
            type: saved.type,
            sourcePath: saved.sourcePath,
            posterPath: saved.posterPath,
            revision: saved.revision,
            markdown,
            warnings: saved.warnings,
            layout: saved.layout ?? null,
          },
        };
      } catch (error) {
        if (error instanceof ArchifyError) {
          throw new Error(`archify_save 失败：\n${diagnosticsText(error)}`);
        }
        throw new Error(`archify_save 失败：${(error as Error).message}`);
      }
    },
  });

  return (pi: ExtensionAPI) => {
    pi.registerTool(guidelinesTool);
    pi.registerTool(saveTool);
  };
}
