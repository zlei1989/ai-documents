import { createHash } from 'node:crypto';

/** 文件/内容原始字节的 sha256；用于 revision、ETag 与预览缓存键（不写进文件） */
export function contentRevision(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
