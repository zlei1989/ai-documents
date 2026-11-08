import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path';
import { TypeManifestSchema, type TypeManifest } from '@aidocs/contracts';
import { atomicWrite } from '@aidocs/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ServiceError } from './service-error';
import { assertInsideRoot, assertValidName, softDelete, trashStamp } from './storage';

export interface TypeSummary {
  /** 目录名即 id（允许中文） */
  name: string;
  description: string;
  /** null = type.yaml 缺失或无法解析 */
  manifest: TypeManifest | null;
  resourceCount: number;
}

export interface TypeDetail {
  manifest: TypeManifest;
  prompt: string;
}

export interface ResourceNode {
  name: string;
  /** 相对 resources/ 的路径，统一正斜杠 */
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  children?: ResourceNode[];
}

export interface CreateTypeInput {
  name: string;
  description?: string;
  model?: string | null;
  /** 从现有类型整目录复制 */
  copyFrom?: string;
}

export interface SaveTypePatch {
  manifest?: Partial<TypeManifest>;
  prompt?: string;
}

/** 各系统自己生成的噪音文件：不进入资源树、不计数 */
const OS_NOISE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/* ---------------- 路径 ---------------- */

function typesRoot(root: string): string {
  return join(resolve(root), 'types');
}

function typeDirOf(root: string, name: string): string {
  return assertInsideRoot(typesRoot(root), join(typesRoot(root), assertValidName(name, '类型名')));
}

function assertTypeExists(root: string, name: string): string {
  const dir = typeDirOf(root, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `类型「${name}」不存在`);
  }
  return dir;
}

function resourcesDirOf(root: string, name: string, create = false): string {
  const dir = join(assertTypeExists(root, name), 'resources');
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 资源相对路径：必须相对、正斜杠、无 . / .. 段 */
export function normalizeResourcePath(relPath: string, kind = '资源路径'): string {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (!raw) throw new ServiceError('VALIDATION', `${kind}不能为空`);
  if (isAbsolute(raw)) throw new ServiceError('VALIDATION', `${kind}必须是相对路径`);
  if (raw.includes('\\')) throw new ServiceError('VALIDATION', `${kind}不能包含反斜杠`);
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ServiceError('VALIDATION', `${kind}不合法：${relPath}`);
  }
  return segments.join('/');
}

function resourceTarget(root: string, name: string, relPath: string): { dir: string; target: string; rel: string } {
  const dir = resourcesDirOf(root, name);
  const rel = normalizeResourcePath(relPath);
  return { dir, rel, target: assertInsideRoot(dir, join(dir, rel)) };
}

/* ---------------- 清单 ---------------- */

function defaultManifest(name: string): TypeManifest {
  return TypeManifestSchema.parse({ name });
}

function readManifest(dir: string, name: string): TypeManifest {
  const file = join(dir, 'type.yaml');
  if (!existsSync(file)) return defaultManifest(name);
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8')) ?? {};
    const manifest = TypeManifestSchema.parse(parsed);
    return { ...manifest, name };
  } catch (error) {
    throw new ServiceError('VALIDATION', `类型「${name}」的 type.yaml 无法解析`, {
      file,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeManifest(dir: string, manifest: TypeManifest): void {
  atomicWrite(join(dir, 'type.yaml'), stringifyYaml(TypeManifestSchema.parse(manifest)));
}

function readPrompt(dir: string): string {
  const file = join(dir, 'prompt.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (OS_NOISE_FILES.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(abs);
    else count += 1;
  }
  return count;
}

/* ---------------- 类型 CRUD ---------------- */

export function listTypes(root: string): TypeSummary[] {
  const dir = typesRoot(root);
  if (!existsSync(dir)) return [];
  const out: TypeSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const typeDir = join(dir, entry.name);
    let manifest: TypeManifest | null = null;
    try {
      manifest = readManifest(typeDir, entry.name);
    } catch {
      manifest = null;
    }
    out.push({
      name: entry.name,
      description: manifest?.description ?? '',
      manifest,
      resourceCount: countFiles(join(typeDir, 'resources')),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export function getType(root: string, name: string): TypeDetail {
  const dir = assertTypeExists(root, name);
  return { manifest: readManifest(dir, name), prompt: readPrompt(dir) };
}

export function createType(root: string, input: CreateTypeInput): TypeDetail {
  const name = assertValidName(input.name, '类型名');
  const targetDir = typeDirOf(root, name);
  if (existsSync(targetDir)) throw new ServiceError('CONFLICT', `类型「${name}」已存在`);

  if (input.copyFrom) {
    const sourceDir = assertTypeExists(root, assertValidName(input.copyFrom, '来源类型名'));
    cpSync(sourceDir, targetDir, { recursive: true });
    const manifest = { ...readManifest(targetDir, name), name };
    writeManifest(targetDir, manifest);
    return { manifest, prompt: readPrompt(targetDir) };
  }

  mkdirSync(join(targetDir, 'resources'), { recursive: true });
  const manifest = defaultManifest(name);
  if (input.description) manifest.description = input.description;
  if (input.model) manifest.model = input.model;
  writeManifest(targetDir, manifest);
  atomicWrite(join(targetDir, 'prompt.md'), '');
  return { manifest, prompt: '' };
}

export function duplicateType(root: string, sourceName: string, newName: string): TypeDetail {
  return createType(root, { name: newName, copyFrom: sourceName });
}

export function saveType(root: string, name: string, patch: SaveTypePatch): TypeDetail {
  const dir = assertTypeExists(root, name);
  const current = readManifest(dir, name);
  const manifest = TypeManifestSchema.parse({
    ...current,
    ...(patch.manifest ?? {}),
    name,
  });
  writeManifest(dir, manifest);
  if (patch.prompt !== undefined) atomicWrite(join(dir, 'prompt.md'), patch.prompt);
  return { manifest, prompt: patch.prompt !== undefined ? patch.prompt : readPrompt(dir) };
}

export function deleteType(root: string, name: string): void {
  const dir = assertTypeExists(root, name);
  softDelete(root, dir, join('types', `${name}-${trashStamp()}`));
}

/* ---------------- 资源文件树 ---------------- */

function walkResources(absDir: string, baseDir: string): ResourceNode[] {
  const nodes: ResourceNode[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (OS_NOISE_FILES.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = join(absDir, entry.name);
    const rel = relative(baseDir, abs).split(sep).join('/');
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, kind: 'dir', children: walkResources(abs, baseDir) });
    } else {
      nodes.push({ name: entry.name, path: rel, kind: 'file', size: statSync(abs).size });
    }
  }
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function listResources(root: string, name: string): ResourceNode[] {
  const dir = resourcesDirOf(root, name);
  if (!existsSync(dir)) return [];
  return walkResources(dir, dir);
}

export function readResource(root: string, name: string, relPath: string): string {
  const { target } = resourceTarget(root, name, relPath);
  if (!existsSync(target)) throw new ServiceError('NOT_FOUND', `资源不存在：${relPath}`);
  if (statSync(target).isDirectory()) throw new ServiceError('VALIDATION', `「${relPath}」是文件夹`);
  return readFileSync(target, 'utf8');
}

export function writeResource(root: string, name: string, relPath: string, content: string): void {
  const { target } = resourceTarget(root, name, relPath);
  if (existsSync(target) && statSync(target).isDirectory()) {
    throw new ServiceError('VALIDATION', `「${relPath}」是文件夹，不能写入`);
  }
  atomicWrite(target, content);
}

export function mkdirResource(root: string, name: string, relPath: string): void {
  const { target } = resourceTarget(root, name, relPath);
  if (existsSync(target)) throw new ServiceError('CONFLICT', `「${relPath}」已存在`);
  mkdirSync(target, { recursive: true });
}

export function renameResource(root: string, name: string, from: string, to: string): void {
  const source = resourceTarget(root, name, from).target;
  if (!existsSync(source)) throw new ServiceError('NOT_FOUND', `资源不存在：${from}`);
  const target = resourceTarget(root, name, to).target;
  if (existsSync(target)) throw new ServiceError('CONFLICT', `目标已存在：${to}`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

export function deleteResource(root: string, name: string, relPath: string): void {
  const { target } = resourceTarget(root, name, relPath);
  if (!existsSync(target)) throw new ServiceError('NOT_FOUND', `资源不存在：${relPath}`);
  rmSync(target, { recursive: true, force: true });
}
