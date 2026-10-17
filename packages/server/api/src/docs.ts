import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ArtifactMetaSchema, type ArtifactMeta, type ArtifactNode } from '@aidocs/contracts';
import { atomicWrite, git, isRepo } from '@aidocs/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ServiceError } from './service-error';
import { assertInsideRoot, assertValidName, commitPath } from './storage';

export interface DocDetail {
  group: string;
  name: string;
  meta: ArtifactMeta;
  main: string;
}

export interface CreateDocInput {
  group: string;
  name: string;
  type: string;
  /** 默认取 name */
  title?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function docsRoot(root: string): string {
  return join(resolve(root), 'docs');
}

function docDirOf(root: string, group: string, name: string): { group: string; name: string; dir: string } {
  const docsDir = docsRoot(root);
  const safeGroup = assertValidName(group, '分组名');
  const safeName = assertValidName(name, '文档名');
  const dir = assertInsideRoot(docsDir, join(docsDir, safeGroup, safeName));
  return { group: safeGroup, name: safeName, dir };
}

function docRel(group: string, name: string): string {
  return `docs/${group}/${name}`;
}

function readMeta(dir: string, group: string, name: string): ArtifactMeta {
  const file = join(dir, 'meta.yaml');
  if (!existsSync(file)) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」缺少 meta.yaml`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8')) ?? {};
  } catch (error) {
    throw new ServiceError('VALIDATION', `文档「${group}/${name}」的 meta.yaml 无法解析`, {
      file,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const result = ArtifactMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new ServiceError('VALIDATION', `文档「${group}/${name}」的 meta.yaml 不符合契约`, { file });
  }
  return result.data;
}

function writeMeta(dir: string, meta: ArtifactMeta): void {
  atomicWrite(join(dir, 'meta.yaml'), stringifyYaml(ArtifactMetaSchema.parse(meta)));
}

function readMain(dir: string): string {
  const file = join(dir, 'MAIN.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function detailOf(root: string, group: string, name: string): DocDetail {
  const { dir } = docDirOf(root, group, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」不存在`);
  }
  return { group, name, meta: readMeta(dir, group, name), main: readMain(dir) };
}

/** 扫描 docs/<group>/<artifact>/，meta.yaml 缺失或损坏时用目录名兜底展示 */
export function listDocs(root: string): ArtifactNode[] {
  const docsDir = docsRoot(root);
  if (!existsSync(docsDir)) return [];
  const nodes: ArtifactNode[] = [];
  for (const groupEntry of readdirSync(docsDir, { withFileTypes: true })) {
    if (!groupEntry.isDirectory() || groupEntry.name.startsWith('.')) continue;
    const groupDir = join(docsDir, groupEntry.name);
    for (const artifactEntry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!artifactEntry.isDirectory() || artifactEntry.name.startsWith('.')) continue;
      const artifactDir = join(groupDir, artifactEntry.name);
      let meta: ArtifactMeta | undefined;
      try {
        meta = readMeta(artifactDir, groupEntry.name, artifactEntry.name);
      } catch {
        meta = undefined;
      }
      let updatedAt = meta?.updatedAt;
      if (!updatedAt) {
        try {
          updatedAt = statSync(join(artifactDir, 'MAIN.md')).mtime.toISOString();
        } catch {
          updatedAt = undefined;
        }
      }
      nodes.push({
        group: groupEntry.name,
        name: artifactEntry.name,
        title: meta?.title ?? artifactEntry.name,
        type: meta?.type ?? '',
        ...(updatedAt ? { updatedAt } : {}),
      });
    }
  }
  return nodes.sort(
    (a, b) => a.group.localeCompare(b.group, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'),
  );
}

/** 新建 Artifact：目录 + meta.yaml + MAIN.md；storageRoot 是 git 仓库则提交一次 */
export function createDoc(root: string, input: CreateDocInput): DocDetail {
  const { group, name, dir } = docDirOf(root, input.group, input.name);
  const type = (input.type ?? '').trim();
  if (!type) throw new ServiceError('VALIDATION', '文档类型不能为空');
  if (existsSync(dir)) throw new ServiceError('CONFLICT', `文档「${group}/${name}」已存在`);

  const title = (input.title?.trim() || name);
  const createdAt = nowIso();
  const meta: ArtifactMeta = { title, type, createdAt, updatedAt: createdAt };
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  for (const sub of ['assets', 'research', 'sessions', '.aidocs']) {
    mkdirSync(/*turbopackIgnore: true*/ join(dir, sub), { recursive: true });
  }
  writeMeta(dir, meta);
  atomicWrite(join(dir, 'MAIN.md'), `# ${title}\n`);

  commitPath(root, docRel(group, name), `human: ${name} · 新建文档\n\nArtifact: ${docRel(group, name)}`);
  return { group, name, meta, main: readMain(dir) };
}

export function getDoc(root: string, group: string, name: string): DocDetail {
  return detailOf(root, group, name);
}

/** 只刷新 meta.updatedAt：供图示等资源保存复用（资源本身由调用方写） */
export function markDocUpdated(root: string, group: string, name: string): ArtifactMeta {
  const { dir } = docDirOf(root, group, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」不存在`);
  }
  const meta = readMeta(dir, group, name);
  const next: ArtifactMeta = { ...meta, updatedAt: nowIso() };
  writeMeta(dir, next);
  return next;
}

/** 人工保存正文：原子写 MAIN.md，刷新 meta.updatedAt */
export function saveMain(root: string, group: string, name: string, main: string): DocDetail {
  const { dir } = docDirOf(root, group, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」不存在`);
  }
  const meta = readMeta(dir, group, name);
  atomicWrite(join(dir, 'MAIN.md'), main);
  const next: ArtifactMeta = { ...meta, updatedAt: nowIso() };
  writeMeta(dir, next);
  return { group, name, meta: next, main };
}

/** 直接删除文档目录；仓库里留一次删除提交，内容可从历史提交找回 */
export function deleteDoc(root: string, group: string, name: string): void {
  const { dir } = docDirOf(root, group, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」不存在`);
  }
  rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  commitPath(root, docRel(group, name), `human: ${name} · 删除文档\n\nArtifact: ${docRel(group, name)}`);
}

/** 重命名：目录改名（仓库内用 git mv）+ 同步 meta.title */
export function renameDoc(root: string, group: string, name: string, newName: string): DocDetail {
  const from = docDirOf(root, group, name);
  if (!existsSync(from.dir) || !statSync(from.dir).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `文档「${group}/${name}」不存在`);
  }
  const safeNewName = assertValidName(newName, '文档名');
  if (safeNewName === name) return detailOf(root, group, name);
  const to = docDirOf(root, group, safeNewName);
  if (existsSync(to.dir)) throw new ServiceError('CONFLICT', `文档「${group}/${safeNewName}」已存在`);

  let moved = false;
  if (isRepo(root)) {
    try {
      git(root, ['mv', '--', docRel(group, name), docRel(group, safeNewName)]);
      moved = true;
    } catch {
      moved = false;
    }
  }
  if (!moved) renameSync(from.dir, to.dir);

  const meta = readMeta(to.dir, group, safeNewName);
  const next: ArtifactMeta = { ...meta, title: safeNewName, updatedAt: nowIso() };
  writeMeta(to.dir, next);
  return { group, name: safeNewName, meta: next, main: readMain(to.dir) };
}
