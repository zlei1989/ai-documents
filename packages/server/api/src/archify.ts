import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArchifyError,
  ARCHIFY_PREVIEW_ROOT,
  ensureArchifyView,
  injectArchifyBridge,
  isArchifyType,
  listArchify,
  normalizeArchifySourcePath,
  normalizeDiagramLayout,
  previewArchifyIr,
  readArchify,
  saveArchify,
  validateArchifyIr,
} from '@aidocs/archify';
import { assertInside } from '@aidocs/core';
import type {
  ArchifyDiagnostic,
  ArchifyDocument,
  ArchifyLayoutResult,
  ArchifyPreviewResult,
  ArchifySummary,
  ArchifyType,
  ArchifyValidateResult,
} from '@aidocs/contracts';
import { markDocUpdated } from './docs';
import { resolveArtifact } from './diagrams';
import { ServiceError } from './service-error';

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function asSourcePath(input: string): string {
  if (input.startsWith('assets/')) return normalizeArchifySourcePath(input);
  return normalizeArchifySourcePath(`assets/${input}`);
}

function interactiveUrl(group: string, name: string, sourcePath: string, revision: string): string {
  return `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}/archify-view/${encodePath(sourcePath)}?v=${encodeURIComponent(revision)}&embed=1&theme=light`;
}

function toDocument(group: string, name: string, root: string, sourcePath: string): ArchifyDocument {
  const artifact = resolveArtifact(root, group, name);
  const doc = readArchify(artifact.dir, sourcePath);
  return {
    sourcePath: doc.sourcePath,
    posterPath: doc.posterPath,
    type: doc.type,
    title: doc.title,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    ir: doc.ir,
    interactiveUrl: interactiveUrl(group, name, doc.sourcePath, doc.revision),
    warnings: doc.warnings,
    layout: doc.layout ?? null,
  };
}

export function getArchifyDocument(root: string, group: string, name: string, sourcePath: string): ArchifyDocument {
  try {
    return toDocument(group, name, root, asSourcePath(sourcePath));
  } catch (error) {
    toServiceError(error);
    throw error;
  }
}

export function listArchifyDocuments(root: string, group: string, name: string): ArchifySummary[] {
  const artifact = resolveArtifact(root, group, name);
  return listArchify(artifact.dir).map((doc) => ({
    sourcePath: doc.sourcePath,
    posterPath: doc.posterPath,
    type: doc.type,
    title: doc.title,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
  }));
}

function diagnosticsContext(error: ArchifyError): Record<string, unknown> {
  return {
    ...(error.options.diagnostics ? { diagnostics: error.options.diagnostics } : {}),
    ...(error.options.warnings ? { warnings: error.options.warnings } : {}),
  };
}

function toServiceError(error: unknown): never {
  if (error instanceof ArchifyError) {
    if (error.options.conflict) {
      throw new ServiceError('CONFLICT', error.message, diagnosticsContext(error));
    }
    if (error.options.stage === 'store' && /不存在/.test(error.message)) {
      throw new ServiceError('NOT_FOUND', error.message, diagnosticsContext(error));
    }
    if (error.options.stage === 'store' && /路径越界|资源路径|不合法|必须以|不是 Archify|源 JSON|解析失败|不是对象|未知 Archify/.test(error.message)) {
      throw new ServiceError('VALIDATION', error.message, diagnosticsContext(error));
    }
    if (error.options.stage === 'validate') {
      throw new ServiceError('VALIDATION', error.message, diagnosticsContext(error));
    }
    if (error.options.stage === 'offline') {
      throw new ServiceError('VALIDATION', error.message, diagnosticsContext(error));
    }
    throw new ServiceError('INTERNAL', error.message, diagnosticsContext(error));
  }
  throw new ServiceError('INTERNAL', `Archify 处理失败：${(error as Error)?.message ?? String(error)}`);
}

export async function saveArchifyDocument(
  root: string,
  group: string,
  name: string,
  sourcePath: string,
  input: {
    ir: Record<string, unknown>;
    baseRevision?: string;
    force?: boolean;
    quality: 'standard' | 'showcase';
  },
): Promise<ArchifyDocument> {
  const artifact = resolveArtifact(root, group, name);
  let source: string;
  try {
    source = asSourcePath(sourcePath);
  } catch (error) {
    toServiceError(error);
    throw error;
  }
  let type: ArchifyType;
  const rawType = input.ir.diagram_type;
  if (isArchifyType(rawType)) type = rawType;
  else {
    try {
      type = readArchify(artifact.dir, source).type;
    } catch (error) {
      toServiceError(error);
      throw error;
    }
  }
  try {
    const saved = await saveArchify(artifact.dir, {
      type,
      ir: input.ir,
      sourcePath: source,
      quality: input.quality,
      ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
      force: input.force ?? false,
      actor: 'human',
    });
    try {
      markDocUpdated(root, group, name);
    } catch {
      /* meta 更新失败不影响图示 */
    }
    return {
      sourcePath: saved.sourcePath,
      posterPath: saved.posterPath,
      type: saved.type,
      title: saved.title,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
      ir: saved.ir,
      interactiveUrl: interactiveUrl(group, name, saved.sourcePath, saved.revision),
      warnings: saved.warnings,
      layout: saved.layout ?? null,
    };
  } catch (error) {
    toServiceError(error);
    throw error;
  }
}

export async function validateArchifyDocument(
  root: string,
  group: string,
  name: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
  quality: 'standard' | 'showcase',
): Promise<ArchifyValidateResult> {
  const artifact = resolveArtifact(root, group, name);
  try {
    const result = await validateArchifyIr(artifact.dir, type, ir, quality);
    return {
      ok: result.ok,
      diagnostics: result.diagnostics as ArchifyDiagnostic[],
      warnings: result.warnings,
      layout: result.layout ?? null,
    };
  } catch (error) {
    toServiceError(error);
    throw error;
  }
}

/** 排版：只做确定性变换，不写盘；编辑器拿到结果后走正常预览/保存 */
export function layoutArchifyDocument(
  root: string,
  group: string,
  name: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
): ArchifyLayoutResult {
  resolveArtifact(root, group, name);
  const result = normalizeDiagramLayout(type, ir);
  return { ir: result.ir, applied: result.applied, warnings: result.warnings };
}

export async function previewArchifyDocument(
  root: string,
  group: string,
  name: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
  quality: 'standard' | 'showcase',
): Promise<ArchifyPreviewResult> {
  const artifact = resolveArtifact(root, group, name);
  try {
    const result = await previewArchifyIr(artifact.dir, type, ir, quality);
    const previewPath = result.previewPath;
    return {
      ok: result.ok,
      diagnostics: result.diagnostics,
      warnings: result.warnings,
      layout: result.layout ?? null,
      previewUrl: previewPath
        ? `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}/archify-preview/${encodePath(previewPath)}?v=${encodeURIComponent(previewPath.split('/').at(-1) ?? '')}&embed=1&theme=light`
        : null,
    };
  } catch (error) {
    toServiceError(error);
    throw error;
  }
}

export interface ArchifyPreviewHtml {
  html: string;
  revision: string;
}

/** 读取实时预览缓存；只允许 .aidocs/archify/preview/<64hex>.html */
export function getArchifyPreviewHtml(
  root: string,
  group: string,
  name: string,
  previewPath: string,
): ArchifyPreviewHtml {
  const artifact = resolveArtifact(root, group, name);
  const normalized = previewPath.replace(/\\/g, '/');
  if (!new RegExp(`^${ARCHIFY_PREVIEW_ROOT.replace('.', '\\.')}/[a-f0-9]{64}\\.html$`).test(normalized)) {
    throw new ServiceError('VALIDATION', 'Archify 预览路径不合法');
  }
  const target = assertInside(artifact.dir, join(artifact.dir, normalized));
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new ServiceError('VALIDATION', 'Archify 预览不能是符号链接');
    if (!info.isFile()) throw new ServiceError('NOT_FOUND', 'Archify 预览不存在');
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('NOT_FOUND', 'Archify 预览不存在');
  }
  const html = injectArchifyBridge(readFileSync(target, 'utf8'));
  return { html, revision: normalized.split('/').at(-1)?.replace('.html', '') ?? '' };
}

export interface ArchifyView {
  html: string;
  revision: string;
  stale: boolean;
  warnings: string[];
}

export async function getArchifyView(
  root: string,
  group: string,
  name: string,
  sourcePath: string,
): Promise<ArchifyView> {
  const artifact = resolveArtifact(root, group, name);
  let source: string;
  try {
    source = asSourcePath(sourcePath);
  } catch (error) {
    toServiceError(error);
    throw error;
  }
  try {
    const view = await ensureArchifyView(artifact.dir, source);
    return {
      html: view.html,
      revision: view.sourceRevision,
      stale: view.stale,
      warnings: view.warnings,
    };
  } catch (error) {
    toServiceError(error);
    throw error;
  }
}
