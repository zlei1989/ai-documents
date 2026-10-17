import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '@aidocs/core';
import { ServiceError } from './service-error';
import { initStorage, storageStatus } from './storage';
import { createDoc, deleteDoc, getDoc, listDocs, renameDoc, saveMain } from './docs';

function tempDir(prefix = 'aidocs-docs-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('docs', () => {
  it('创建中文分组与文档，落盘 meta/MAIN 并可列出', () => {
    const root = tempDir();

    const doc = createDoc(root, { group: '产品', name: '文档生成应用', type: '技术方案' });
    expect(doc.meta.title).toBe('文档生成应用');
    expect(doc.meta.type).toBe('技术方案');
    expect(doc.main).toContain('文档生成应用');

    const dir = join(root, 'docs', '产品', '文档生成应用');
    expect(existsSync(join(dir, 'meta.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'MAIN.md'))).toBe(true);
    expect(existsSync(join(dir, 'assets'))).toBe(true);
    expect(existsSync(join(dir, 'research'))).toBe(true);
    expect(existsSync(join(dir, 'sessions'))).toBe(true);
    expect(existsSync(join(dir, '.aidocs'))).toBe(true);

    const metaRaw = readFileSync(join(dir, 'meta.yaml'), 'utf8');
    expect(metaRaw).toContain('文档生成应用');
    expect(metaRaw).toContain('技术方案');

    const list = listDocs(root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ group: '产品', name: '文档生成应用', title: '文档生成应用', type: '技术方案' });

    const loaded = getDoc(root, '产品', '文档生成应用');
    expect(loaded.main).toBe(doc.main);
    expect(listDocs(root)[0]?.updatedAt).toBeTruthy();
  });

  it('保存 MAIN.md 并刷新 updatedAt', () => {
    const root = tempDir();
    const created = createDoc(root, { group: '产品', name: '文档生成应用', type: '技术方案' });
    const saved = saveMain(root, '产品', '文档生成应用', '# 新正文\n\n第一段。\n');

    expect(saved.main).toBe('# 新正文\n\n第一段。\n');
    expect(readFileSync(join(root, 'docs', '产品', '文档生成应用', 'MAIN.md'), 'utf8')).toBe('# 新正文\n\n第一段。\n');
    expect(saved.meta.updatedAt).toBeTruthy();
    expect(Date.parse(saved.meta.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(created.meta.createdAt));
  });

  it('保存 MAIN.md 只写文件：不产生 git 提交，也不推送', () => {
    const root = tempDir();
    initStorage(root);
    createDoc(root, { group: '产品', name: '文档生成应用', type: '技术方案' });
    const before = storageStatus(root).commitCount;

    saveMain(root, '产品', '文档生成应用', '# 人工保存的正文\n');

    const status = storageStatus(root);
    expect(status.commitCount).toBe(before);
    expect(status.recentCommits[0]?.summary).toContain('新建文档');
    expect(status.dirty).toBe(true);
  });

  it('storageRoot 是 git 仓库时，首次创建产生一次提交', () => {
    const root = tempDir();
    initStorage(root);
    expect(storageStatus(root).commitCount).toBe(1);

    createDoc(root, { group: '产品', name: '文档生成应用', type: '技术方案' });

    const status = storageStatus(root);
    expect(status.isRepo).toBe(true);
    expect(status.commitCount).toBe(2);
    expect(status.recentCommits[0]?.summary).toContain('新建文档');
    expect(status.recentCommits[0]?.origin).toBe('human');
  });

  it('删除文档：直接删掉目录，仓库里留一次删除提交（可从历史恢复）', () => {
    const root = tempDir();
    initStorage(root);
    createDoc(root, { group: '产品', name: '文档生成应用', type: '技术方案' });

    deleteDoc(root, '产品', '文档生成应用');
    expect(existsSync(join(root, 'docs', '产品', '文档生成应用'))).toBe(false);
    expect(existsSync(join(root, '.trash'))).toBe(false);
    expect(listDocs(root)).toEqual([]);
    const status = storageStatus(root);
    expect(status.commitCount).toBe(3);
    expect(status.recentCommits[0]?.summary).toContain('删除文档');
    // 删除前的提交仍保留正文，git 历史就是恢复来源
    expect(git(root, ['show', 'HEAD~1:docs/产品/文档生成应用/MAIN.md']).stdout).toContain('文档生成应用');
  });

  it('重命名文档：目录改名并同步 meta title', () => {
    const root = tempDir();
    initStorage(root);
    createDoc(root, { group: '产品', name: '旧名字', type: '技术方案' });

    const renamed = renameDoc(root, '产品', '旧名字', '新名字');
    expect(renamed.name).toBe('新名字');
    expect(renamed.meta.title).toBe('新名字');
    expect(existsSync(join(root, 'docs', '产品', '旧名字'))).toBe(false);
    expect(existsSync(join(root, 'docs', '产品', '新名字', 'MAIN.md'))).toBe(true);
    expect(listDocs(root).map((node) => node.name)).toEqual(['新名字']);
  });

  it('路径穿越与非法名称被拒绝', () => {
    const root = tempDir();
    expect(() => createDoc(root, { group: '../逃逸', name: 'x', type: '技术方案' })).toThrowError(ServiceError);
    expect(() => createDoc(root, { group: '产品', name: 'a/b', type: '技术方案' })).toThrowError(ServiceError);
    expect(() => getDoc(root, '产品', '../..')).toThrowError(ServiceError);
    expect(() => getDoc(root, '不存在', '文档')).toThrowError(/不存在/);
    createDoc(root, { group: '产品', name: '文档', type: '技术方案' });
    expect(() => createDoc(root, { group: '产品', name: '文档', type: '技术方案' })).toThrowError(/已存在/);
  });
});
