import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DocFileContent, DocFileListing, DocFileNode } from '@aidocs/contracts';
import { PathEscapeError, assertInside, assetContentType, assetExtension } from '@aidocs/core';
import { readRawAsset, resolveArtifact, type ArtifactTarget, type RawAsset } from './diagrams';
import { ServiceError } from './service-error';

/** 目录最多返回多少项（文件 + 文件夹）；超出只返回前一部分 */
const MAX_LIST_ENTRIES = 2000;
/** 目录最多递归多少层 */
const MAX_LIST_DEPTH = 12;
/** 各系统自己生成的噪音文件：不进入文档文件树 */
const OS_NOISE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** 文本预览最多读取多少字节 */
const MAX_PREVIEW_BYTES = 256 * 1024;

/** 会按纯文本预览的扩展名；图片（svg/png/jpg/...）单独按 image 处理 */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.toml',
  '.ini',
]);

/** 文件路径必须是文档目录内的相对路径：无空段、无 . / ..、无隐藏段、无反斜杠 */
function normalizeDocFileRelPath(input: string): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new ServiceError('VALIDATION', '文件路径不能为空');
  if (raw.startsWith('/')) throw new ServiceError('VALIDATION', `文件路径必须是相对路径：${input}`);
  if (/^[A-Za-z]:[\\/]/.test(raw)) throw new ServiceError('VALIDATION', `文件路径不合法：${input}`);
  if (raw.includes('\\')) throw new ServiceError('VALIDATION', '文件路径不能包含反斜杠');
  const segments = raw.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new ServiceError('VALIDATION', `文件路径不合法：${input}`);
    }
    if (segment.startsWith('.')) {
      throw new ServiceError('VALIDATION', `不能访问隐藏文件或目录：${segment}`);
    }
    if (/[\u0000-\u001f]/.test(segment)) {
      throw new ServiceError('VALIDATION', '文件路径不能包含控制字符');
    }
  }
  return segments.join('/');
}

interface ResolvedDocFile {
  rel: string;
  /** realpath 校验后的绝对路径 */
  abs: string;
  info: Stats;
}

/** 解析单个文件：相对路径合法、落在文档目录内、是常规文件且不是符号链接 */
function resolveDocFile(artifact: ArtifactTarget, relPath: string): ResolvedDocFile {
  const rel = normalizeDocFileRelPath(relPath);
  const rawTarget = join(artifact.dir, rel);

  // 先对未解析的路径做 lstat：assertInside 会 realpath，符号链接会被解掉，必须在这之前拒绝
  if (!existsSync(rawTarget)) throw new ServiceError('NOT_FOUND', `文件不存在：${rel}`);
  let info: Stats;
  try {
    info = lstatSync(rawTarget);
  } catch {
    throw new ServiceError('NOT_FOUND', `文件不存在：${rel}`);
  }
  if (info.isSymbolicLink()) throw new ServiceError('VALIDATION', `文件不能是符号链接：${rel}`);
  if (info.isDirectory()) throw new ServiceError('VALIDATION', `「${rel}」是文件夹`);
  if (!info.isFile()) throw new ServiceError('VALIDATION', `「${rel}」不是常规文件`);

  let abs: string;
  try {
    abs = assertInside(artifact.dir, rawTarget);
  } catch (error) {
    if (error instanceof PathEscapeError) throw new ServiceError('VALIDATION', `路径越界：${relPath}`);
    throw error;
  }
  return { rel, abs, info };
}

interface WalkState {
  entries: number;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

function sortNodes(nodes: DocFileNode[]): DocFileNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/**
 * 递归扫描文档目录。
 * 隐藏项（. 开头）、.DS_Store、符号链接不进入树；目录在前、名称按中文排序。
 */
function walkDocDir(dir: string, baseDir: string, depth: number, state: WalkState): DocFileNode[] {
  if (state.truncated) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) {
      throw new ServiceError('INTERNAL', '读取文档目录失败', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }

  const nodes: DocFileNode[] = [];
  for (const entry of entries) {
    if (state.truncated) break;
    if (state.entries >= MAX_LIST_ENTRIES) {
      state.truncated = true;
      break;
    }
    if (OS_NOISE_FILES.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;

    const abs = join(dir, entry.name);
    const rel = relative(baseDir, abs).split(sep).join('/');
    let info: Stats;
    try {
      info = lstatSync(abs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;

    state.entries += 1;
    if (info.isDirectory()) {
      let children: DocFileNode[] = [];
      if (depth >= MAX_LIST_DEPTH) {
        state.truncated = true;
      } else {
        children = walkDocDir(abs, baseDir, depth + 1, state);
      }
      nodes.push({
        name: entry.name,
        path: rel,
        kind: 'dir',
        updatedAt: info.mtime.toISOString(),
        children,
      });
    } else if (info.isFile()) {
      state.fileCount += 1;
      state.totalBytes += info.size;
      nodes.push({
        name: entry.name,
        path: rel,
        kind: 'file',
        size: info.size,
        updatedAt: info.mtime.toISOString(),
      });
    }
  }
  return sortNodes(nodes);
}

/** 文档文件夹树（只读）：所有可见文件与子目录 */
export function listDocFiles(root: string, group: string, name: string): DocFileListing {
  const artifact = resolveArtifact(root, group, name);
  const state: WalkState = { entries: 0, fileCount: 0, totalBytes: 0, truncated: false };
  const entries = walkDocDir(artifact.dir, artifact.dir, 0, state);
  return {
    root: `docs/${artifact.group}/${artifact.name}`,
    entries,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    truncated: state.truncated,
  };
}

function textMediaType(ext: string): string {
  if (ext === '.md' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.json' || ext === '.jsonl') return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/** 只读前 MAX_PREVIEW_BYTES，避免把大 jsonl / 日志整个读进内存 */
function readTextPreview(file: string, size: number): { text: string; truncated: boolean } {
  const length = Math.min(size, MAX_PREVIEW_BYTES);
  if (length === 0) return { text: '', truncated: false };

  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString('utf8');
    const truncated = size > offset;
    // 截断点可能落在多字节字符中间，去掉末尾替换字符
    if (truncated) text = text.replace(/\uFFFD$/, '');
    return { text, truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * 单个文件预览元信息 + 文本内容。
 * 图片只返回元信息（前端走 /files/raw）；其他未知格式按 binary 处理。
 */
export function readDocFile(root: string, group: string, name: string, relPath: string): DocFileContent {
  const artifact = resolveArtifact(root, group, name);
  const { rel, abs, info } = resolveDocFile(artifact, relPath);
  const filename = rel.slice(rel.lastIndexOf('/') + 1);
  const updatedAt = info.mtime.toISOString();
  const meta = assetContentType(rel);

  if (meta.inline) {
    return {
      path: rel,
      name: filename,
      kind: 'image',
      mediaType: meta.type,
      size: info.size,
      updatedAt,
      text: null,
      truncated: false,
    };
  }

  const ext = assetExtension(rel);
  if (TEXT_EXTENSIONS.has(ext)) {
    const preview = readTextPreview(abs, info.size);
    return {
      path: rel,
      name: filename,
      kind: 'text',
      mediaType: textMediaType(ext),
      size: info.size,
      updatedAt,
      text: preview.text,
      truncated: preview.truncated,
    };
  }

  return {
    path: rel,
    name: filename,
    kind: 'binary',
    mediaType: 'application/octet-stream',
    size: info.size,
    updatedAt,
    text: null,
    truncated: false,
  };
}

/** 原始文件字节：图片 inline，其他 attachment；SVG 会净化 */
export function readDocFileRaw(root: string, group: string, name: string, relPath: string): RawAsset {
  const artifact = resolveArtifact(root, group, name);
  const { rel, abs } = resolveDocFile(artifact, relPath);
  const filename = rel.slice(rel.lastIndexOf('/') + 1);
  return readRawAsset(abs, rel, filename, '文件');
}
