import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './fs-safe';
import { normalizeAssetPath } from './diagram';

/**
 * 「图示被手动编辑过」的轻量提醒。
 *
 * 源画布能力用 SQLite + 历史副本替换来保证模型看到最新 HTML；本项目里
 * 文件就是最新版本，模型也能用 read 工具读取，所以这里只记录「哪些图示
 * 在会话之外被改过」。下一轮 composePrompt 注入路径提醒，模型先 read 再改。
 *
 * 文件放在 <artifact>/.aidocs/ 下（已 gitignore），不进入版本历史。
 */

export interface DiagramEditNote {
  /** 完整资源路径，例如 assets/diagrams/x.svg */
  path: string;
  /** 手动保存后的文件 sha256 */
  revision: string;
  /** ISO 时间 */
  at: string;
}

const NOTES_REL = join('.aidocs', 'diagram-edits.json');
const MAX_NOTES = 20;

function notesFile(artifactDir: string): string {
  return join(artifactDir, NOTES_REL);
}

function safePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  try {
    return normalizeAssetPath(path);
  } catch {
    return null;
  }
}

/** 读取提醒；损坏/缺失/已删除文件都静默忽略 */
export function readDiagramEditNotes(artifactDir: string): DiagramEditNote[] {
  const file = notesFile(artifactDir);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const rawNotes = (parsed as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(rawNotes)) return [];
  const byPath = new Map<string, DiagramEditNote>();
  for (const raw of rawNotes) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const path = safePath(item.path);
    if (!path) continue;
    if (typeof item.revision !== 'string' || typeof item.at !== 'string') continue;
    if (!existsSync(join(artifactDir, path))) continue;
    byPath.set(path, { path, revision: item.revision, at: item.at });
  }
  return [...byPath.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_NOTES);
}

/** 记录一次手动保存；同一路径覆盖为最新 revision。 */
export function recordDiagramEditNote(artifactDir: string, note: DiagramEditNote): void {
  const path = safePath(note.path);
  if (!path) return;
  const current = readDiagramEditNotes(artifactDir);
  const next = current.filter((item) => item.path !== path);
  next.push({ path, revision: note.revision, at: note.at });
  next.sort((a, b) => a.at.localeCompare(b.at));
  const capped = next.slice(-MAX_NOTES);
  atomicWrite(notesFile(artifactDir), `${JSON.stringify({ version: 1, notes: capped }, null, 2)}\n`);
}

/** 清空指定路径的提醒；不给 paths 则全部清空。 */
export function clearDiagramEditNotes(artifactDir: string, paths?: string[]): void {
  const file = notesFile(artifactDir);
  if (!existsSync(file)) return;
  const current = readDiagramEditNotes(artifactDir);
  if (!paths) {
    atomicWrite(file, `${JSON.stringify({ version: 1, notes: [] }, null, 2)}\n`);
    return;
  }
  const remove = new Set(paths.map((path) => safePath(path)).filter((path): path is string => Boolean(path)));
  const next = current.filter((item) => !remove.has(item.path));
  atomicWrite(file, `${JSON.stringify({ version: 1, notes: next }, null, 2)}\n`);
}
