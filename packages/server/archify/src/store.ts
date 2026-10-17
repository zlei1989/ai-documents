import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import {
  PathEscapeError,
  assertInside,
  atomicWrite,
  clearDiagramEditNotes,
  diagramSlug,
  normalizeAssetPath,
  recordDiagramEditNote,
  contentRevision,
} from '@aidocs/core';
import { extractArchifyPoster, injectArchifyBridge, sanitizeArchifyPoster } from './poster';
import { renderArchify, validateArchify } from './run';
import { gridPlaceArchitecture, lintLayout, normalizeDiagramLayout, type ArchifyLayoutReport } from './layout';
import {
  ArchifyError,
  ARCHIFY_TYPES_SET,
  type ArchifyArtifacts,
  type ArchifyQuality,
  type ArchifyValidation,
  type SaveArchifyOptions,
} from './types';

const SOURCE_SUFFIX = '.archify.json';
const POSTER_SUFFIX = '.archify.svg';
const HTML_SUFFIX = '.archify.html';
const CACHE_ROOT = '.aidocs/archify';

export interface CacheMeta {
  sourceRevision: string;
  generatedAt: string;
  htmlSha: string;
  posterSha: string;
  warnings: string[];
  layout?: ArchifyLayoutReport;
}

export interface ArchifyReadResult {
  sourcePath: string;
  posterPath: string;
  type: ArchifyType;
  title: string;
  revision: string;
  updatedAt: string;
  ir: Record<string, unknown>;
  warnings: string[];
  layout?: ArchifyLayoutReport;
}

export interface ArchifyViewResult {
  html: string;
  sourceRevision: string;
  stale: boolean;
  warnings: string[];
  layout?: ArchifyLayoutReport;
}

function assertArtifactDir(artifactDir: string): string {
  const abs = resolve(artifactDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new ArchifyError(`文档目录不存在：${abs}`, { stage: 'store' });
  }
  return abs;
}

function assertRegularFile(target: string, kind = '文件'): void {
  if (!existsSync(target)) throw new ArchifyError(`${kind}不存在`, { stage: 'store' });
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new ArchifyError(`${kind}不能是符号链接`, { stage: 'store' });
  if (!info.isFile()) throw new ArchifyError(`${kind}不是常规文件`, { stage: 'store' });
}

function insideArtifact(artifactDir: string, target: string): string {
  try {
    return assertInside(artifactDir, target);
  } catch (error) {
    if (error instanceof PathEscapeError) throw new ArchifyError(`路径越界：${target}`, { stage: 'store' });
    throw error;
  }
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

export function isArchifyType(value: unknown): value is ArchifyType {
  return typeof value === 'string' && ARCHIFY_TYPES_SET.has(value);
}

/** 完整源路径：assets/...x.archify.json */
export function normalizeArchifySourcePath(input: string): string {
  let path: string;
  try {
    path = normalizeAssetPath(input);
  } catch (error) {
    throw new ArchifyError((error as Error).message, { stage: 'store' });
  }
  if (!path.toLowerCase().endsWith(SOURCE_SUFFIX)) {
    throw new ArchifyError(`Archify 源路径必须以 ${SOURCE_SUFFIX} 结尾`, { stage: 'store' });
  }
  return path;
}

export function sourcePathForTitle(title: string): string {
  return `assets/diagrams/${diagramSlug(title)}${SOURCE_SUFFIX}`;
}

export function posterPathForSource(sourcePath: string): string {
  const source = normalizeArchifySourcePath(sourcePath);
  return source.slice(0, -SOURCE_SUFFIX.length) + POSTER_SUFFIX;
}

export function cacheRelForSource(sourcePath: string): string {
  const source = normalizeArchifySourcePath(sourcePath);
  const rel = source.slice('assets/'.length, -SOURCE_SUFFIX.length);
  return `${CACHE_ROOT}/${rel}${HTML_SUFFIX}`;
}

export function metaRelForSource(sourcePath: string): string {
  const source = normalizeArchifySourcePath(sourcePath);
  const rel = source.slice('assets/'.length, -SOURCE_SUFFIX.length);
  return `${CACHE_ROOT}/${rel}.meta.json`;
}

export function sourcePathFromPoster(posterPath: string): string {
  const path = normalizeAssetPath(posterPath);
  if (!path.toLowerCase().endsWith(POSTER_SUFFIX)) {
    throw new ArchifyError(`不是 Archify 海报：${posterPath}`, { stage: 'store' });
  }
  return path.slice(0, -POSTER_SUFFIX.length) + SOURCE_SUFFIX;
}

function sourceResolved(artifactDir: string, sourcePath: string): { source: string; poster: string; cache: string; meta: string } {
  const root = assertArtifactDir(artifactDir);
  const sourceRel = normalizeArchifySourcePath(sourcePath);
  const source = insideArtifact(root, join(root, sourceRel));
  const posterRel = posterPathForSource(sourceRel);
  const poster = insideArtifact(root, join(root, posterRel));
  const cache = insideArtifact(root, join(root, cacheRelForSource(sourceRel)));
  const meta = insideArtifact(root, join(root, metaRelForSource(sourceRel)));
  return { source, poster, cache, meta };
}

function stripOfflineFields(value: unknown, warnings: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripOfflineFields(item, warnings));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'brand') {
      warnings.add('已移除 brand（离线模式不抓取品牌）');
      continue;
    }
    if (key === 'sources') {
      warnings.add('已移除 sources（离线模式不做仓库证据校验）');
      continue;
    }
    if (key === 'repository') {
      warnings.add('已移除 repository（离线模式不做仓库证据校验）');
      continue;
    }
    out[key] = stripOfflineFields(entry, warnings);
  }
  return out;
}

export interface NormalizedIr {
  ir: Record<string, unknown>;
  title: string;
  type: ArchifyType;
  warnings: string[];
}

export function normalizeArchifyIr(input: unknown, type: ArchifyType, options: {
  title?: string;
  output: string;
  quality: ArchifyQuality;
}): NormalizedIr {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ArchifyError('Archify IR 必须是 JSON 对象', { stage: 'validate' });
  }
  const warnings = new Set<string>();
  const cloned = stripOfflineFields(structuredClone(input), warnings) as Record<string, unknown>;
  cloned.diagram_type = type;
  const metaRaw = cloned.meta;
  const meta = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
    ? { ...(metaRaw as Record<string, unknown>) }
    : {};
  const title = (options.title?.trim() || (typeof meta.title === 'string' ? meta.title.trim() : '') || '图示');
  meta.title = title;
  meta.output = options.output;
  if (typeof meta.locale !== 'string' || !meta.locale.trim()) meta.locale = 'zh-CN';
  if (typeof meta.visual_preset !== 'string' || !meta.visual_preset.trim()) meta.visual_preset = 'classic';
  if (typeof meta.animation !== 'string') meta.animation = 'trace';
  meta.quality_profile = options.quality;
  cloned.meta = meta;
  const json = JSON.stringify(cloned);
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) {
    throw new ArchifyError('Archify IR 过大（上限 256KB）', { stage: 'validate' });
  }
  return { ir: cloned, title, type, warnings: [...warnings] };
}

export function readArchify(artifactDir: string, sourcePath: string): ArchifyReadResult {
  const { source, poster } = sourceResolved(artifactDir, sourcePath);
  assertRegularFile(source, 'Archify 源文件');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, 'utf8')) as unknown;
  } catch (error) {
    throw new ArchifyError(`Archify 源 JSON 解析失败：${(error as Error).message}`, { stage: 'store' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArchifyError('Archify 源 JSON 不是对象', { stage: 'store' });
  }
  const ir = parsed as Record<string, unknown>;
  const type = ir.diagram_type;
  if (!isArchifyType(type)) throw new ArchifyError(`未知 Archify 类型：${String(type)}`, { stage: 'store' });
  const meta = (ir.meta && typeof ir.meta === 'object' ? ir.meta : {}) as Record<string, unknown>;
  const posterRel = posterPathForSource(sourcePath);
  const info = statSync(source);
  const cacheMeta = readCacheMeta(artifactDir, sourcePath);
  return {
    sourcePath: normalizeArchifySourcePath(sourcePath),
    posterPath: posterRel,
    type,
    title: typeof meta.title === 'string' ? meta.title : '',
    revision: contentRevision(readFileSync(source)),
    updatedAt: info.mtime.toISOString(),
    ir,
    warnings: cacheMeta?.warnings ?? [],
    ...(cacheMeta?.layout ? { layout: cacheMeta.layout } : {}),
  };
}

export function listArchify(artifactDir: string): ArchifyReadResult[] {
  const root = assertArtifactDir(artifactDir);
  const base = join(root, 'assets');
  if (!existsSync(base)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(SOURCE_SUFFIX)) {
        found.push(posix(relative(root, full)));
      }
    }
  };
  walk(base, 0);
  const items: ArchifyReadResult[] = [];
  for (const sourcePath of found.sort()) {
    try {
      items.push(readArchify(artifactDir, sourcePath));
    } catch {
      /* 单个坏文件不影响列表 */
    }
  }
  return items;
}

function isLayoutReport(value: unknown): value is ArchifyLayoutReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return (
    typeof report.score === 'number' &&
    typeof report.summary === 'string' &&
    Array.isArray(report.issues)
  );
}

function readCacheMeta(artifactDir: string, sourcePath: string): CacheMeta | null {
  const { meta } = sourceResolved(artifactDir, sourcePath);
  if (!existsSync(meta)) return null;
  try {
    const parsed = JSON.parse(readFileSync(meta, 'utf8')) as Partial<CacheMeta>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sourceRevision !== 'string') return null;
    return {
      sourceRevision: parsed.sourceRevision,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      htmlSha: typeof parsed.htmlSha === 'string' ? parsed.htmlSha : '',
      posterSha: typeof parsed.posterSha === 'string' ? parsed.posterSha : '',
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string') : [],
      ...(isLayoutReport(parsed.layout) ? { layout: parsed.layout } : {}),
    };
  } catch {
    return null;
  }
}

function writeCacheMeta(artifactDir: string, sourcePath: string, meta: CacheMeta): void {
  const { meta: metaPath } = sourceResolved(artifactDir, sourcePath);
  atomicWrite(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/** 把渲染器的原始 layout receipt 变成可读的 lint 报告，并合并 warning 文本 */
/** architecture 缺坐标时先自动排版，避免 vendor 渲染器直接抛 internal error */
function ensureArchitectureGeometry(type: ArchifyType, normalized: NormalizedIr): NormalizedIr {
  if (type !== 'architecture') return normalized;
  const components = Array.isArray(normalized.ir.components) ? normalized.ir.components : [];
  if (components.length === 0) return normalized;
  const layout = normalized.ir.layout;
  const isGrid = Boolean(
    layout &&
    typeof layout === 'object' &&
    !Array.isArray(layout) &&
    (layout as Record<string, unknown>).mode === 'grid',
  );
  if (isGrid) return normalized;
  const missing = components.some((component) => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) return true;
    const pos = (component as Record<string, unknown>).pos;
    return !Array.isArray(pos) || pos.length < 2;
  });
  if (!missing) return normalized;
  const result = normalizeDiagramLayout('architecture', normalized.ir);
  if (result.applied) {
    return { ...normalized, ir: result.ir, warnings: [...normalized.warnings, ...result.warnings] };
  }
  const fallback = gridPlaceArchitecture(normalized.ir);
  if (fallback.applied) {
    return {
      ...normalized,
      ir: fallback.ir,
      warnings: [...normalized.warnings, ...result.warnings, ...fallback.warnings],
    };
  }
  // 结构本身可能就非法（缺 type/端点）；把诊断留给 vendor，不要用布局错误盖掉 schema 错误。
  return {
    ...normalized,
    warnings: [
      ...normalized.warnings,
      ...result.warnings,
      ...fallback.warnings,
      '组件缺少 pos/size，自动排版未应用；按原 IR 校验。',
    ],
  };
}

function withLayoutLint(
  type: ArchifyType,
  ir: Record<string, unknown>,
  validation: ArchifyValidation,
): ArchifyValidation {
  if (!validation.ok || !validation.layoutReceipt) return validation;
  const layout = lintLayout(type, ir, validation.layoutReceipt);
  if (layout.issues.length === 0) return { ...validation, layout };
  return {
    ...validation,
    layout,
    warnings: [...new Set([...validation.warnings, ...layout.issues.map((issue) => issue.message)])],
  };
}

export interface RenderArtifactsOptions {
  artifactDir: string;
  sourcePath: string;
  type: ArchifyType;
  ir: Record<string, unknown>;
  quality: ArchifyQuality;
  title: string;
}

export interface RenderArtifactsResult {
  html: string;
  posterHtml: string;
  posterWarnings: string[];
  validation: ArchifyValidation;
  revision: string;
  layout?: ArchifyLayoutReport;
}

function makeTempDir(artifactDir: string): string {
  const dir = join(artifactDir, '.aidocs', 'archify', 'tmp', `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 校验 + 渲染 + 提取海报；不写正式文件 */
export async function renderArchifyArtifacts(options: RenderArtifactsOptions): Promise<RenderArtifactsResult> {
  const artifactDir = assertArtifactDir(options.artifactDir);
  const sourceRel = normalizeArchifySourcePath(options.sourcePath);
  const cacheRel = cacheRelForSource(sourceRel);
  const normalized = normalizeArchifyIr(options.ir, options.type, {
    title: options.title,
    output: cacheRel,
    quality: options.quality,
  });
  const sourceJson = `${JSON.stringify(normalized.ir, null, 2)}\n`;
  const revision = contentRevision(sourceJson);
  const temp = makeTempDir(artifactDir);
  try {
    const input = join(temp, 'diagram.json');
    atomicWrite(input, sourceJson);
    const validation = withLayoutLint(
      options.type,
      normalized.ir,
      await validateArchify(options.type, input, options.quality, artifactDir),
    );
    if (!validation.ok) {
      throw new ArchifyError('Archify 校验未通过', {
        stage: 'validate',
        diagnostics: validation.diagnostics,
        warnings: validation.warnings,
      });
    }
    const htmlPath = join(temp, 'diagram.html');
    await renderArchify(options.type, input, htmlPath, options.quality, artifactDir);
    const html = injectArchifyBridge(readFileSync(htmlPath, 'utf8'));
    const poster = extractArchifyPoster(html);
    return {
      html,
      posterHtml: poster.svg,
      posterWarnings: poster.warnings,
      validation,
      revision,
      ...(validation.layout ? { layout: validation.layout } : {}),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export interface SavedArchify extends ArchifyArtifacts {
  ir: Record<string, unknown>;
  html: string;
}

/** 编辑器/AI 保存：事务式校验/渲染/提取后写源 JSON、海报、HTML 缓存 */
export async function saveArchify(artifactDir: string, options: SaveArchifyOptions): Promise<SavedArchify> {
  const root = assertArtifactDir(artifactDir);
  const quality = options.quality ?? 'showcase';
  let sourceRel: string;
  let existing = false;
  if (options.sourcePath) {
    sourceRel = normalizeArchifySourcePath(options.sourcePath);
    const { source } = sourceResolved(root, sourceRel);
    existing = existsSync(source);
    if (existing) assertRegularFile(source, 'Archify 源文件');
  } else {
    const base = sourcePathForTitle(options.title?.trim() || '图示');
    sourceRel = base;
    let index = 2;
    while (existsSync(join(root, sourceRel))) {
      sourceRel = base.replace(/\.archify\.json$/i, `-${index}.archify.json`);
      index += 1;
    }
  }

  const { source, poster, cache, meta: metaPath } = sourceResolved(root, sourceRel);
  for (const [target, label] of [
    [source, '源文件'],
    [poster, '海报'],
    [cache, '交互缓存'],
    [metaPath, '缓存元数据'],
  ] as const) {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new ArchifyError(`Archify ${label}不能是符号链接`, { stage: 'store' });
    }
  }
  if (existing && !options.force && options.actor !== 'ai') {
    if (!options.baseRevision) {
      throw new ArchifyError('保存 Archify 图缺少 baseRevision，请刷新后重试', { stage: 'store' });
    }
    const current = contentRevision(readFileSync(source));
    if (current !== options.baseRevision) {
      throw new ArchifyError('Archify 源文件已被修改，请重新加载后再保存', {
        stage: 'store',
        diagnostics: [],
        conflict: true,
      });
    }
  }

  const layoutWarnings: string[] = [];
  const shouldAutoLayout =
    (options.autoLayout ?? !existing) && (options.type === 'architecture' || options.type === 'workflow');
  const layoutResult = shouldAutoLayout ? normalizeDiagramLayout(options.type, options.ir) : null;
  if (layoutResult) layoutWarnings.push(...layoutResult.warnings);
  const normalized = ensureArchitectureGeometry(
    options.type,
    normalizeArchifyIr(layoutResult?.ir ?? options.ir, options.type, {
      ...(options.title ? { title: options.title } : {}),
      output: cacheRelForSource(sourceRel),
      quality,
    }),
  );
  if (layoutWarnings.length > 0) normalized.warnings = [...normalized.warnings, ...layoutWarnings];
  const sourceJson = `${JSON.stringify(normalized.ir, null, 2)}\n`;
  const revision = contentRevision(sourceJson);
  if (existing && revision === (options.baseRevision ?? '')) {
    const current = readArchify(root, sourceRel);
    return {
      sourcePath: sourceRel,
      posterPath: posterPathForSource(sourceRel),
      type: current.type,
      title: current.title,
      revision: current.revision,
      updatedAt: current.updatedAt,
      htmlPath: cacheRelForSource(sourceRel),
      warnings: current.warnings,
      ir: current.ir,
      html: existsSync(cache) ? readFileSync(cache, 'utf8') : '',
      ...(current.layout ? { layout: current.layout } : {}),
    };
  }

  const temp = makeTempDir(root);
  let html = '';
  let posterHtml = '';
  let posterWarnings: string[] = [];
  let validationWarnings: string[] = [];
  let layoutReport: ArchifyLayoutReport | undefined;
  try {
    const input = join(temp, 'diagram.json');
    atomicWrite(input, sourceJson);
    const validation = withLayoutLint(options.type, normalized.ir, await validateArchify(options.type, input, quality, root));
    validationWarnings = validation.warnings;
    layoutReport = validation.layout;
    if (!validation.ok) {
      throw new ArchifyError('Archify 校验未通过', {
        stage: 'validate',
        diagnostics: validation.diagnostics,
        warnings: validation.warnings,
      });
    }
    const htmlPath = join(temp, 'diagram.html');
    await renderArchify(options.type, input, htmlPath, quality, root);
    html = injectArchifyBridge(readFileSync(htmlPath, 'utf8'));
    const posterResult = extractArchifyPoster(html);
    posterHtml = posterResult.svg;
    posterWarnings = posterResult.warnings;
    // 二次安全净化（海报路由也会再做一次）
    posterHtml = sanitizeArchifyPoster(posterHtml).svg;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const warnings = [...new Set([...normalized.warnings, ...validationWarnings, ...posterWarnings])];
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(poster), { recursive: true });
  mkdirSync(dirname(cache), { recursive: true });

  // 先写派生文件，最后写源；源写入失败时下一次 view 会按 revision 再生成。
  atomicWrite(cache, html);
  atomicWrite(poster, posterHtml);
  const cacheMeta: CacheMeta = {
    sourceRevision: revision,
    generatedAt: new Date().toISOString(),
    htmlSha: contentRevision(html),
    posterSha: contentRevision(posterHtml),
    warnings,
    ...(layoutReport ? { layout: layoutReport } : {}),
  };
  atomicWrite(metaPath, `${JSON.stringify(cacheMeta, null, 2)}\n`);
  atomicWrite(source, sourceJson);

  try {
    if (options.actor === 'ai') clearDiagramEditNotes(root, [sourceRel]);
    else recordDiagramEditNote(root, { path: sourceRel, revision, at: new Date().toISOString() });
  } catch {
    /* marker 失败不阻断保存 */
  }

  return {
    sourcePath: sourceRel,
    posterPath: posterPathForSource(sourceRel),
    type: options.type,
    title: normalized.title,
    revision,
    updatedAt: new Date().toISOString(),
    htmlPath: cacheRelForSource(sourceRel),
    warnings,
    ir: normalized.ir,
    html,
    ...(layoutReport ? { layout: layoutReport } : {}),
  };
}

export const ARCHIFY_PREVIEW_ROOT = '.aidocs/archify/preview';
const PREVIEW_LIMIT = 12;

export interface ArchifyPreview {
  ok: boolean;
  diagnostics: ArchifyDiagnostic[];
  warnings: string[];
  /** 相对 artifact 的 .aidocs/archify/preview/<hash>.html */
  previewPath?: string;
  layout?: ArchifyLayoutReport;
}

function prunePreviews(artifactDir: string, keep: string): void {
  const dir = join(artifactDir, ARCHIFY_PREVIEW_ROOT);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(dir, name))
    .filter((path) => path !== keep)
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { path: string; mtime: number } => item !== null)
    .sort((a, b) => a.mtime - b.mtime);
  while (files.length >= PREVIEW_LIMIT) {
    const oldest = files.shift();
    if (oldest) {
      rmSync(oldest.path, { force: true });
      rmSync(oldest.path.replace(/\.html$/, '.json'), { force: true });
    }
  }
}

/** 实时预览：validate + render 到 .aidocs 缓存；不写源/海报/marker */
export async function previewArchifyIr(
  artifactDir: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
  quality: ArchifyQuality,
  title = '图示',
): Promise<ArchifyPreview> {
  const root = assertArtifactDir(artifactDir);
  const normalized = ensureArchitectureGeometry(
    type,
    normalizeArchifyIr(ir, type, {
      title,
      output: `${ARCHIFY_PREVIEW_ROOT}/pending.html`,
      quality,
    }),
  );
  const hashIr = structuredClone(normalized.ir);
  const hashMeta = hashIr.meta;
  if (hashMeta && typeof hashMeta === 'object' && !Array.isArray(hashMeta)) {
    delete (hashMeta as Record<string, unknown>).output;
  }
  const key = contentRevision(
    JSON.stringify({ salt: 'archify-preview-v1', type, quality, ir: hashIr }),
  );
  const previewRel = `${ARCHIFY_PREVIEW_ROOT}/${key}.html`;
  const previewPath = insideArtifact(root, join(root, previewRel));
  const previewMetaPath = previewPath.replace(/\.html$/, '.json');
  if (existsSync(previewPath)) {
    assertRegularFile(previewPath, 'Archify 预览缓存');
    let warnings: string[] = [];
    let layout: ArchifyLayoutReport | undefined;
    if (existsSync(previewMetaPath)) {
      try {
        const cached = JSON.parse(readFileSync(previewMetaPath, 'utf8')) as { warnings?: unknown; layout?: unknown };
        warnings = Array.isArray(cached.warnings) ? cached.warnings.filter((item): item is string => typeof item === 'string') : [];
        if (isLayoutReport(cached.layout)) layout = cached.layout;
      } catch {
        /* 旧缓存/坏 sidecar 不影响预览 */
      }
    }
    return {
      ok: true,
      diagnostics: [],
      warnings,
      previewPath: previewRel,
      ...(layout ? { layout } : {}),
    };
  }

  const meta = (normalized.ir.meta && typeof normalized.ir.meta === 'object'
    ? normalized.ir.meta
    : {}) as Record<string, unknown>;
  const previewIr: Record<string, unknown> = {
    ...normalized.ir,
    meta: { ...meta, output: previewRel },
  };
  const temp = makeTempDir(root);
  try {
    const input = join(temp, 'diagram.json');
    atomicWrite(input, `${JSON.stringify(previewIr, null, 2)}\n`);
    const validation = withLayoutLint(type, previewIr, await validateArchify(type, input, quality, root));
    if (!validation.ok) {
      return {
        ok: false,
        diagnostics: validation.diagnostics,
        warnings: [...new Set([...normalized.warnings, ...validation.warnings])],
      };
    }
    const output = join(temp, 'preview.html');
    await renderArchify(type, input, output, quality, root);
    const html = injectArchifyBridge(readFileSync(output, 'utf8'));
    mkdirSync(dirname(previewPath), { recursive: true });
    atomicWrite(previewPath, html);
    const previewWarnings = [...new Set([...normalized.warnings, ...validation.warnings])];
    atomicWrite(
      previewMetaPath,
      `${JSON.stringify({ warnings: previewWarnings, ...(validation.layout ? { layout: validation.layout } : {}) }, null, 2)}\n`,
    );
    prunePreviews(root, previewPath);
    return {
      ok: true,
      diagnostics: [],
      warnings: previewWarnings,
      previewPath: previewRel,
      ...(validation.layout ? { layout: validation.layout } : {}),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** 只校验 IR（编辑器「校验」按钮/测试）；不写正式文件 */
export async function validateArchifyIr(
  artifactDir: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
  quality: ArchifyQuality,
  title = '图示',
): Promise<ArchifyValidation> {
  const root = assertArtifactDir(artifactDir);
  const normalized = ensureArchitectureGeometry(
    type,
    normalizeArchifyIr(ir, type, { title, output: `${CACHE_ROOT}/validate.html`, quality }),
  );
  const temp = makeTempDir(root);
  try {
    const input = join(temp, 'diagram.json');
    atomicWrite(input, `${JSON.stringify(normalized.ir, null, 2)}\n`);
    const validation = withLayoutLint(type, normalized.ir, await validateArchify(type, input, quality, root));
    return {
      ...validation,
      warnings: [...new Set([...normalized.warnings, ...validation.warnings])],
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** 确保 viewer HTML 缓存与源 revision 一致；不一致时重新渲染；失败保留 last-good */
export async function ensureArchifyView(artifactDir: string, sourcePath: string): Promise<ArchifyViewResult> {
  const root = assertArtifactDir(artifactDir);
  const doc = readArchify(root, sourcePath);
  const { cache } = sourceResolved(root, doc.sourcePath);
  const cachedMeta = readCacheMeta(root, doc.sourcePath);
  if (existsSync(cache)) assertRegularFile(cache, 'Archify 交互缓存');
  if (existsSync(cache) && cachedMeta?.sourceRevision === doc.revision) {
    return {
      html: injectArchifyBridge(readFileSync(cache, 'utf8')),
      sourceRevision: doc.revision,
      stale: false,
      warnings: cachedMeta.warnings,
      ...(cachedMeta.layout ? { layout: cachedMeta.layout } : {}),
    };
  }

  try {
    const rendered = await renderArchifyArtifacts({
      artifactDir: root,
      sourcePath: doc.sourcePath,
      type: doc.type,
      ir: doc.ir,
      quality: (doc.ir.meta as Record<string, unknown> | undefined)?.quality_profile === 'standard' ? 'standard' : 'showcase',
      title: doc.title,
    });
    mkdirSync(dirname(cache), { recursive: true });
    atomicWrite(cache, rendered.html);
    writeCacheMeta(root, doc.sourcePath, {
      sourceRevision: doc.revision,
      generatedAt: new Date().toISOString(),
      htmlSha: contentRevision(rendered.html),
      posterSha: '',
      warnings: [...new Set([...rendered.validation.warnings, ...rendered.posterWarnings])],
      ...(rendered.layout ? { layout: rendered.layout } : {}),
    });
    // 源可能已被外部编辑但未同步 revision；缓存按当前 IR 重新生成，返回当前文件 revision。
    return {
      html: rendered.html,
      sourceRevision: doc.revision,
      stale: false,
      warnings: [...new Set([...rendered.validation.warnings, ...rendered.posterWarnings])],
      ...(rendered.layout ? { layout: rendered.layout } : {}),
    };
  } catch (error) {
    if (existsSync(cache)) {
      return {
        html: injectArchifyBridge(readFileSync(cache, 'utf8')),
        sourceRevision: doc.revision,
        stale: true,
        warnings: [error instanceof ArchifyError ? error.message : String(error)],
        ...(cachedMeta?.layout ? { layout: cachedMeta.layout } : {}),
      };
    }
    throw error;
  }
}
