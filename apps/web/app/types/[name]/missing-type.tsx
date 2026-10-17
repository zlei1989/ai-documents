'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@aidocs/ui';
import { docToWorkspaceHref, typeEditorHref } from '../../_lib/doc-nav';
import { settingsTabHref } from '../../_lib/settings-tabs';

/**
 * 类型不存在时的落地页。
 *
 * 典型场景：文档 meta.yaml 里还留着某类型名，但类型目录已被删除/改名。
 * 旧实现直接 notFound()，于是「文档 → 编辑类型」是一条死链；这里给出来路
 * （回到原文档）与一键创建同名类型，跳转不再断。
 */
export function MissingType({ name, doc, reason }: { name: string; doc?: string; reason: string }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState('');
  const backHref = docToWorkspaceHref(doc) ?? '/docs';
  const backLabel = doc ? '← 回到文档' : '← 返回文档列表';
  const editorHref = typeEditorHref(name, doc);

  async function createType(): Promise<void> {
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/types', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      router.replace(editorHref);
    } catch (createError) {
      setError((createError as Error).message);
      setCreating(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <p className="text-xs font-medium tracking-wide text-amber-600">类型不存在</p>
      <h1 className="text-xl font-semibold text-zinc-900">类型「{name}」还没有创建</h1>
      <p className="max-w-xl break-words text-sm leading-relaxed text-zinc-500">
        {doc ? (
          <>
            文档 <span className="font-mono text-zinc-700">{doc}</span> 引用了这个类型，但磁盘上的类型目录已不存在。
          </>
        ) : (
          '这个类型目录不存在，可能是刚被删除或改名。'
        )}
      </p>
      <p className="max-w-xl break-all text-xs text-zinc-400">{reason}</p>
      {error ? <p className="text-xs text-red-600">创建失败：{error}</p> : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => void createType()} disabled={creating}>
          {creating ? '创建中…' : `创建「${name}」并编辑`}
        </Button>
        <Link href={backHref} className={buttonVariants({ variant: 'outline' })}>
          {backLabel}
        </Link>
        <Link href={settingsTabHref('types')} className={buttonVariants({ variant: 'ghost' })}>
          去设置管理类型
        </Link>
      </div>
      <p className="text-[11px] leading-5 text-zinc-400">
        创建后会得到一个空白方法论；保存后，引用该类型的文档下一轮会话生效。
      </p>
    </main>
  );
}
