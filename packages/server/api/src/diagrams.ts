import { lstatSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MAX_ASSET_BYTES,
  PathEscapeError,
  assertInside,
  assetContentType,
  contentRevision,
  normalizeAssetPath,
  normalizeAssetRelativePath,
} from '@aidocs/core';
import { ArchifyError, sanitizeArchifyPoster } from '@aidocs/archify';
import { assertInsideRoot, assertValidName } from './storage';
import { ServiceError } from './service-error';

export interface ArtifactTarget {
  storageRoot: string;
  group: string;
  name: string;
  dir: string;
}

/** 解析并校验文档目录：名称合法、落在 storageRoot/docs 内、目录存在 */
export function resolveArtifact(root: string, group: string, name: string): ArtifactTarget {
  const storageRoot = resolve(root);
  const docsDir = join(storageRoot, 'docs');
  const safeGroup = assertValidName(group, '分组名');
  const safeName = assertValidName(name, '文档名');
  const dir = assertInsideRoot(docsDir, join(docsDir, safeGroup, safeName));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${safeGroup}/${safeName}」不存在`);
  }
  return { storageRoot, group: safeGroup, name: safeName, dir };
}

function assertRegularFile(target: string, kind = '文件'): void {
  if (!existsSync(target)) throw new ServiceError('NOT_FOUND', `${kind}不存在`);
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new ServiceError('VALIDATION', `${kind}不能是符号链接`);
  if (!info.isFile()) throw new ServiceError('VALIDATION', `${kind}不是常规文件`);
}

function insideArtifact(artifact: ArtifactTarget, target: string): string {
  try {
    return assertInside(artifact.dir, target);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw new ServiceError('VALIDATION', `路径越界：${target}`);
    }
    throw error;
  }
}

function toValidationError(error: unknown, prefix: string): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ArchifyError) return new ServiceError('VALIDATION', error.message);
  return new ServiceError('VALIDATION', `${prefix}：${(error as Error)?.message ?? String(error)}`);
}

/** 供对话框/测试使用：确认路径属于文档 assets/ */
export function resolveAssetFile(artifact: ArtifactTarget, relPath: string): { rel: string; path: string; fullPath: string } {
  let rel: string;
  try {
    rel = normalizeAssetRelativePath(relPath);
  } catch (error) {
    throw new ServiceError('VALIDATION', (error as Error).message);
  }
  const assetsDir = join(artifact.dir, 'assets');
  const fullPath = `${'assets'}/${rel}`;
  const rawTarget = join(artifact.dir, fullPath);
  let isSymlink = false;
  try {
    isSymlink = lstatSync(rawTarget).isSymbolicLink();
  } catch {
    /* ENOENT：交给后续读取报 404 */
  }
  if (isSymlink) throw new ServiceError('VALIDATION', '资源文件不能是符号链接');
  const target = assertInsideRoot(artifact.storageRoot, rawTarget);
  try {
    assertInside(assetsDir, target);
  } catch (error) {
    if (error instanceof PathEscapeError) throw new ServiceError('VALIDATION', `路径越界：${target}`);
    throw error;
  }
  return { rel, path: target, fullPath };
}

export interface RawAsset {
  bytes: Buffer;
  contentType: string;
  inline: boolean;
  etag: string;
  lastModified: string;
  filename: string;
  /** 与当前响应体对应的版本（SVG 已净化，但 etag 基于原始文件） */
  revision: string;
  size: number;
}

/**
 * 读原始资源：仅图片 inline，其他一律 attachment。
 * SVG（含 Archify 海报）统一走 poster 净化：保留 class/style，禁脚本/事件/外链；
 * 不提供 SVG 编辑器，普通 SVG 只读展示。
 */
export function readAsset(root: string, group: string, name: string, relPath: string): RawAsset {
  const artifact = resolveArtifact(root, group, name);
  const { path, fullPath } = resolveAssetFile(artifact, relPath);
  const filename = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  return readRawAsset(path, fullPath, filename, '资源文件');
}

/**
 * 读文档内任意常规文件的原始字节（assets 之外也可用）。
 * 图片 inline；其他一律 attachment；SVG 与海报同净化，ETag 基于原始字节。
 * 调用方负责先校验路径落在文档目录内。
 */
export function readRawAsset(path: string, typePath: string, filename: string, label = '文件'): RawAsset {
  assertRegularFile(path, label);
  const info = statSync(path);
  if (info.size > MAX_ASSET_BYTES) {
    throw new ServiceError('VALIDATION', `${label}过大（上限 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB）`);
  }
  const raw = readFileSync(path);
  const revision = contentRevision(raw);
  const meta = assetContentType(typePath);
  let bytes = raw;
  if (meta.type.startsWith('image/svg+xml')) {
    try {
      bytes = Buffer.from(sanitizeArchifyPoster(raw.toString('utf8')).svg, 'utf8');
    } catch (error) {
      throw toValidationError(error, '图示读取失败');
    }
  }
  return {
    bytes,
    contentType: meta.type,
    inline: meta.inline,
    etag: `"${revision}"`,
    lastModified: info.mtime.toUTCString(),
    filename,
    revision,
    size: bytes.length,
  };
}

export { normalizeAssetPath };
