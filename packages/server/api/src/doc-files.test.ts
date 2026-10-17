import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocFileNode } from '@aidocs/contracts';
import { createDoc } from './docs';
import { listDocFiles, readDocFile, readDocFileRaw } from './doc-files';
import { ServiceError } from './service-error';

const GROUP = '分组';
const NAME = '文档';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:red}</style><rect class="a" width="10" height="10"/><script>alert(1)</script></svg>';

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aidocs-doc-files-'));
  createDoc(root, { group: GROUP, name: NAME, type: '类型' });
  dir = join(root, 'docs', GROUP, NAME);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function flatten(nodes: DocFileNode[], out = new Map<string, DocFileNode>()): Map<string, DocFileNode> {
  for (const node of nodes) {
    out.set(node.path, node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

describe('doc-files 列表', () => {
  it('递归展示目录、文件与大小；隐藏项/DS_Store 不出现', () => {
    write('assets/images/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('research/笔记.md', '# 笔记\n');
    write('.aidocs/cache.md', '内部缓存');
    write('.DS_Store', 'x');

    const listing = listDocFiles(root, GROUP, NAME);
    const nodes = flatten(listing.entries);

    expect(listing.root).toBe(`docs/${GROUP}/${NAME}`);
    expect([...nodes.keys()]).toEqual(
      expect.arrayContaining(['assets', 'assets/images', 'assets/images/a.png', 'research', 'research/笔记.md', 'MAIN.md', 'meta.yaml']),
    );
    expect(nodes.has('.aidocs')).toBe(false);
    expect(nodes.has('.aidocs/cache.md')).toBe(false);
    expect(nodes.has('.DS_Store')).toBe(false);
    expect(nodes.get('assets/images/a.png')?.size).toBe(4);
    expect(nodes.get('assets')?.kind).toBe('dir');
    expect(listing.fileCount).toBe(4);
    expect(listing.totalBytes).toBe(
      ['MAIN.md', 'meta.yaml', 'research/笔记.md', 'assets/images/a.png'].reduce(
        (sum, rel) => sum + statSync(join(dir, rel)).size,
        0,
      ),
    );
    expect(listing.truncated).toBe(false);
  });

  it('目录在前、名称排序；空目录 children 为空数组', () => {
    write('aaa.txt', 'a');
    write('zzz.txt', 'z');
    const listing = listDocFiles(root, GROUP, NAME);
    const names = listing.entries.map((entry) => entry.name);
    expect(names.slice(0, 3)).toEqual(['assets', 'research', 'sessions']);
    expect(names).toContain('MAIN.md');
    expect(names).toContain('meta.yaml');
    expect(names.indexOf('MAIN.md')).toBeGreaterThan(names.indexOf('sessions'));
    expect(listing.entries.find((entry) => entry.name === 'assets')?.children).toEqual([]);
  });

  it('符号链接不进入树', () => {
    symlinkSync(join(dir, 'MAIN.md'), join(dir, 'main-link.md'));
    const nodes = flatten(listDocFiles(root, GROUP, NAME).entries);
    expect(nodes.has('main-link.md')).toBe(false);
  });

  it('文档不存在返回 NOT_FOUND', () => {
    expect(() => listDocFiles(root, '不存在', '文档')).toThrow(ServiceError);
    expect(() => listDocFiles(root, '不存在', '文档')).toThrow(/不存在/);
  });
});

describe('doc-files 预览', () => {
  it('按扩展名区分 text / image / binary', () => {
    write('assets/images/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('data.bin', Buffer.from([0, 1, 2]));

    const main = readDocFile(root, GROUP, NAME, 'MAIN.md');
    expect(main).toMatchObject({ path: 'MAIN.md', kind: 'text', truncated: false });
    expect(main.text).toContain(NAME);

    const note = readDocFile(root, GROUP, NAME, 'meta.yaml');
    expect(note.kind).toBe('text');
    expect(note.mediaType).toBe('text/plain; charset=utf-8');

    const image = readDocFile(root, GROUP, NAME, 'assets/images/a.png');
    expect(image).toMatchObject({ kind: 'image', text: null, mediaType: 'image/png' });

    const binary = readDocFile(root, GROUP, NAME, 'data.bin');
    expect(binary).toMatchObject({ kind: 'binary', text: null });
  });

  it('文本预览超过 256KB 截断', () => {
    write('big.log', 'a'.repeat(300 * 1024));
    const preview = readDocFile(root, GROUP, NAME, 'big.log');
    expect(preview.kind).toBe('text');
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.text ?? '', 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('路径穿越、隐藏段、目录、缺失文件、符号链接都被拒绝', () => {
    writeFileSync(join(root, 'secret.txt'), 'secret');
    expect(() => readDocFile(root, GROUP, NAME, '../secret.txt')).toThrow(/路径不合法/);
    expect(() => readDocFile(root, GROUP, NAME, '../../secret.txt')).toThrow(/路径不合法/);
    expect(() => readDocFile(root, GROUP, NAME, '/etc/passwd')).toThrow(/相对路径/);
    expect(() => readDocFile(root, GROUP, NAME, '.aidocs/cache.md')).toThrow(/隐藏/);
    expect(() => readDocFile(root, GROUP, NAME, 'assets')).toThrow(/文件夹/);
    expect(() => readDocFile(root, GROUP, NAME, 'missing.md')).toThrow(/不存在/);

    symlinkSync(join(dir, 'MAIN.md'), join(dir, 'main-link.md'));
    expect(() => readDocFile(root, GROUP, NAME, 'main-link.md')).toThrow(/符号链接/);
  });

  it('空文本文件返回空串', () => {
    write('empty.md', '');
    const content = readDocFile(root, GROUP, NAME, 'empty.md');
    expect(content.text).toBe('');
    expect(content.truncated).toBe(false);
  });
});

describe('doc-files 原始文件', () => {
  it('图片 inline、非图片 attachment；SVG 净化', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    write('assets/images/a.png', png);
    write('assets/images/x.svg', SVG);

    const image = readDocFileRaw(root, GROUP, NAME, 'assets/images/a.png');
    expect(image.bytes.equals(png)).toBe(true);
    expect(image.contentType).toBe('image/png');
    expect(image.inline).toBe(true);
    expect(image.etag).toMatch(/^"[0-9a-f]{64}"$/);

    const md = readDocFileRaw(root, GROUP, NAME, 'MAIN.md');
    expect(md.contentType).toBe('application/octet-stream');
    expect(md.inline).toBe(false);

    const svg = readDocFileRaw(root, GROUP, NAME, 'assets/images/x.svg');
    expect(svg.contentType).toContain('image/svg+xml');
    expect(svg.inline).toBe(true);
    expect(svg.bytes.toString('utf8')).not.toContain('<script');
  });
});
