import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Link from 'next/link';
import { getType } from '@aidocs/api';
import { readConfig } from '@aidocs/core';
import { WorkspaceShell } from './workspace-shell';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage({ params }: { params: Promise<{ group: string; name: string }> }) {
  const raw = await params;
  const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  const group = decode(raw.group);
  const name = decode(raw.name);
  const config = readConfig();
  const root = config.settings.storageRoot;
  const artifactDir = root ? join(root, 'docs', group, name) : '';
  const mainPath = artifactDir ? join(artifactDir, 'MAIN.md') : '';
  const metaPath = artifactDir ? join(artifactDir, 'meta.yaml') : '';

  if (!root || !existsSync(mainPath)) {
    return (
      <main className="flex min-h-dvh w-full flex-col items-start justify-center px-4 py-12 sm:px-6 lg:px-10">
        <h1 className="text-lg font-semibold">文档未找到</h1>
        <p className="mt-2 break-all text-sm text-zinc-500">{root ? `路径：${artifactDir}` : '尚未在设置页配置存储目录。'}</p>
        <Link href="/settings" className="mt-4 inline-block text-sm underline">去设置</Link>
      </main>
    );
  }

  const text = readFileSync(mainPath, 'utf8');
  const metaRaw = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : '';
  const typeName = /type:\s*(.+)/.exec(metaRaw)?.[1]?.trim() ?? '';
  // 类型目录可能已被删除/改名；和 /types 页用同一条读取路径判断存在性，
  // 让「编辑类型」入口不至于静默变成死链。
  let typeExists = false;
  if (typeName) {
    try {
      getType(root, typeName);
      typeExists = true;
    } catch {
      typeExists = false;
    }
  }

  return (
    <WorkspaceShell
      group={group}
      name={name}
      text={text}
      typeName={typeName}
      typeExists={typeExists}
    />
  );
}
