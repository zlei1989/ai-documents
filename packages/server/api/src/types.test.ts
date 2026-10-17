import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceError } from './service-error';
import {
  createType,
  deleteType,
  duplicateType,
  getType,
  listResources,
  listTypes,
  readResource,
  renameResource,
  saveType,
  writeResource,
} from './types';

function tempDir(prefix = 'aidocs-types-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('types', () => {
  it('创建中文类型并保存清单与提示词', () => {
    const root = tempDir();

    const created = createType(root, { name: '技术方案', description: '教模型写技术方案' });
    expect(created.manifest.name).toBe('技术方案');
    expect(created.prompt).toBe('');
    expect(existsSync(join(root, 'types', '技术方案', 'type.yaml'))).toBe(true);
    expect(existsSync(join(root, 'types', '技术方案', 'resources'))).toBe(true);

    const saved = saveType(root, '技术方案', {
      manifest: {
        ...created.manifest,
        skills: ['mermaid-diagram'],
        resources: [{ path: '模板/方案模板.md', mustRead: true }],
      },
      prompt: '你是技术方案作者。',
    });
    expect(saved.manifest.skills).toEqual(['mermaid-diagram']);
    expect(saved.manifest.resources).toEqual([{ path: '模板/方案模板.md', mustRead: true }]);

    const raw = readFileSync(join(root, 'types', '技术方案', 'type.yaml'), 'utf8');
    expect(raw).toContain('技术方案');
    expect(getType(root, '技术方案').prompt).toBe('你是技术方案作者。');
    expect(listTypes(root).map((t) => t.name)).toEqual(['技术方案']);
  });

  it('复制类型时整目录拷贝并更新 name', () => {
    const root = tempDir();
    createType(root, { name: '技术方案', description: '原类型' });
    writeResource(root, '技术方案', '模板/方案模板.md', '# 模板\n');

    const copy = duplicateType(root, '技术方案', '技术方案副本');
    expect(copy.manifest.name).toBe('技术方案副本');
    expect(copy.manifest.description).toBe('原类型');
    expect(readResource(root, '技术方案副本', '模板/方案模板.md')).toBe('# 模板\n');

    expect(() => duplicateType(root, '技术方案', '技术方案副本')).toThrowError(ServiceError);
    expect(() => duplicateType(root, '不存在', '新类型')).toThrowError(/不存在/);
  });

  it('资源树可列、可读写、可重命名', () => {
    const root = tempDir();
    createType(root, { name: '技术方案' });

    writeResource(root, '技术方案', '模板/方案模板.md', '# 方案\n');
    writeResource(root, '技术方案', '参考资料/检索引擎笔记.md', '笔记\n');

    const tree = listResources(root, '技术方案');
    expect(tree.map((node) => node.name)).toEqual(['参考资料', '模板']);
    const template = tree.find((node) => node.name === '模板');
    expect(template?.kind).toBe('dir');
    expect(template?.children?.[0]?.path).toBe('模板/方案模板.md');

    expect(readResource(root, '技术方案', '模板/方案模板.md')).toBe('# 方案\n');

    renameResource(root, '技术方案', '模板/方案模板.md', '模板/模板 renamed.md');
    expect(existsSync(join(root, 'types', '技术方案', 'resources', '模板', '模板 renamed.md'))).toBe(true);

    const fileStat = statSync(join(root, 'types', '技术方案', 'resources', '模板', '模板 renamed.md'));
    expect(fileStat.isFile()).toBe(true);
  });

  it('路径穿越与非法名称被拒绝', () => {
    const root = tempDir();
    createType(root, { name: '技术方案' });

    expect(() => createType(root, { name: '../逃逸' })).toThrowError(ServiceError);
    expect(() => createType(root, { name: 'a/b' })).toThrowError(ServiceError);
    expect(() => writeResource(root, '技术方案', '../../outside.md', 'x')).toThrowError(ServiceError);
    expect(() => writeResource(root, '技术方案', '/etc/evil', 'x')).toThrowError(ServiceError);
    expect(() => readResource(root, '技术方案', '../type.yaml')).toThrowError(/越界|路径/);
    expect(() => renameResource(root, '技术方案', '不存在.md', 'x.md')).toThrowError(ServiceError);
  });

  it('删除类型软删到 .trash', () => {
    const root = tempDir();
    createType(root, { name: '技术方案' });
    deleteType(root, '技术方案');

    expect(existsSync(join(root, 'types', '技术方案'))).toBe(false);
    expect(listTypes(root)).toEqual([]);
    expect(existsSync(join(root, '.trash'))).toBe(true);
    const trashed = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(trashed).toContain('.trash/');
  });
});
