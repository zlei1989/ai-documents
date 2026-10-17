import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDiagramEditNotes,
  readDiagramEditNotes,
  recordDiagramEditNote,
} from './diagram-edits';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidocs-diagram-notes-'));
  mkdirSync(join(dir, 'assets', 'diagrams'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(path: string, content = '<svg/>'): void {
  const abs = join(dir, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('diagram edit notes', () => {
  it('记录/读取/去重/清理', () => {
    touch('assets/diagrams/a.svg');
    touch('assets/diagrams/b.svg');
    recordDiagramEditNote(dir, { path: 'assets/diagrams/a.svg', revision: 'r1', at: '2026-01-01T00:00:00.000Z' });
    recordDiagramEditNote(dir, { path: 'assets/diagrams/b.svg', revision: 'r2', at: '2026-01-02T00:00:00.000Z' });
    recordDiagramEditNote(dir, { path: 'assets/diagrams/a.svg', revision: 'r3', at: '2026-01-03T00:00:00.000Z' });

    const notes = readDiagramEditNotes(dir);
    expect(notes).toHaveLength(2);
    expect(notes.find((note) => note.path.endsWith('a.svg'))?.revision).toBe('r3');

    clearDiagramEditNotes(dir, ['assets/diagrams/a.svg']);
    expect(readDiagramEditNotes(dir).map((note) => note.path)).toEqual(['assets/diagrams/b.svg']);

    clearDiagramEditNotes(dir);
    expect(readDiagramEditNotes(dir)).toEqual([]);
  });

  it('已删除文件不进入提醒，损坏文件静默忽略', () => {
    recordDiagramEditNote(dir, { path: 'assets/diagrams/gone.svg', revision: 'r', at: '2026-01-01T00:00:00.000Z' });
    expect(readDiagramEditNotes(dir)).toEqual([]);

    mkdirSync(join(dir, '.aidocs'), { recursive: true });
    writeFileSync(join(dir, '.aidocs', 'diagram-edits.json'), '{bad json');
    expect(readDiagramEditNotes(dir)).toEqual([]);
  });

  it('非法路径不写入', () => {
    recordDiagramEditNote(dir, { path: '../secret.svg', revision: 'r', at: '2026-01-01T00:00:00.000Z' });
    expect(readDiagramEditNotes(dir)).toEqual([]);
  });
});
