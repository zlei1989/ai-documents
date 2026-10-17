'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { TypeManifest } from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, Checkbox, Input, Tabs, Textarea } from '@aidocs/ui';
import { Dialog } from '../../_components/dialog';
import { docToWorkspaceHref, typeEditorHref } from '../../_lib/doc-nav';
import { settingsTabHref } from '../../_lib/settings-tabs';

interface SkillOption { name: string; description: string; origin: string; enabled: boolean }
interface McpOption { name: string; transport: string; enabled: boolean }

interface PreviewResult {
  systemPrompt: string;
  chars: number;
  tools: string[];
  resources: string[];
  mcpServers: string[];
  cwd: string;
}

/** 注入预览：服务端按真实装配路径（buildPiSession）算出的完整系统提示词 */
function useInjectionPreview(input: {
  name: string;
  prompt: string;
  manifest: TypeManifest;
  doc?: string;
  enabled: boolean;
}): { preview: PreviewResult | null; loading: boolean; error: string } {
  const { name, prompt, manifest, doc, enabled } = input;
  const [preview, setPreview] = React.useState<PreviewResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!enabled) return;
    // 装配一次约 0.3–0.6s：停止输入 500ms 后再算，且只保留最后一次结果
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/types/${encodeURIComponent(name)}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, manifest, ...(doc ? { doc } : {}) }),
        });
        const data = (await res.json().catch(() => ({}))) as PreviewResult & { error?: string };
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setPreview(data);
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, name, prompt, manifest, doc]);

  return { preview, loading, error };
}

export function TypeEditor({
  name,
  prompt: initialPrompt,
  manifest: initialManifest,
  skills,
  mcp,
  doc,
}: {
  name: string;
  prompt: string;
  manifest: TypeManifest;
  skills: SkillOption[];
  mcp: McpOption[];
  /** 从某篇文档进入时为 `group/name`，注入预览的 cwd 段用它的目录 */
  doc?: string;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState(initialPrompt);
  const [manifest, setManifest] = React.useState<TypeManifest>(initialManifest);
  const [tab, setTab] = React.useState('prompt');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [copyName, setCopyName] = React.useState<string | null>(null);
  const [copyError, setCopyError] = React.useState('');
  const [copying, setCopying] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const dirty = prompt !== initialPrompt || JSON.stringify(manifest) !== JSON.stringify(initialManifest);
  // 有 ?doc 时直达原文档；没有时回类型列表。不再用 router.back()：
  // 新标签页/刷新/直达进入时没有可回退的历史，会把用户卡在死路。
  const docHref = docToWorkspaceHref(doc);
  const backHref = docHref ?? settingsTabHref('types');
  const backLabel = docHref ? '回到文档' : '回到类型列表';

  function leaveEditor(): void {
    if (dirty && !window.confirm('有未保存的改动，确定离开？')) return;
    router.push(backHref);
  }

  // 规格 6.2：未保存离开提醒
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const toggle = (key: 'skills' | 'mcp', value: string) => {
    setManifest((prev) => {
      const list = prev[key];
      const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
      return { ...prev, [key]: next };
    });
  };

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/types/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, prompt }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      setMessage('已保存 · 进行中的会话下一轮生效');
      router.refresh();
    } catch (error) {
      setMessage(`保存失败：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function openCopy() {
    setCopyError('');
    setCopyName(name.length > 76 ? name : `${name}-副本`);
  }

  async function copyType() {
    const next = (copyName ?? '').trim();
    if (!next) {
      setCopyError('类型名不能为空');
      return;
    }
    if (/[/\\]/.test(next) || next.startsWith('.')) {
      setCopyError('类型名不能包含 / \\，也不能以 . 开头');
      return;
    }
    setCopying(true);
    setCopyError('');
    try {
      const res = await fetch('/api/types', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: next, copyFrom: name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      router.push(typeEditorHref(next, doc));
    } catch (error) {
      setCopyError(`复制失败：${(error as Error).message}`);
      setCopying(false);
    }
  }

  async function removeType() {
    setDeleting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/types/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      router.push(settingsTabHref('types'));
    } catch (error) {
      setMessage(`删除失败：${(error as Error).message}`);
      setDeleteOpen(false);
      setDeleting(false);
    }
  }

  // 注入预览不再本地拼字符串：每次都让服务端按真实装配路径算
  const { preview, loading: previewLoading, error: previewError } = useInjectionPreview({
    name,
    prompt,
    manifest,
    ...(doc ? { doc } : {}),
    enabled: tab === 'preview',
  });

  return (
    <main className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-3 py-2 sm:px-4">
        <span className="text-xs text-zinc-500">类型编辑</span>
        <span className="text-sm font-medium">{name}</span>
        <Badge>{manifest.skills.length} 技能 · {manifest.mcp.length} MCP</Badge>
        {doc ? <span className="max-w-[42vw] truncate text-xs text-zinc-400" title={doc}>来自文档 {doc}</span> : null}
        {dirty && <Badge className="bg-amber-50 text-amber-700">未保存</Badge>}
        <span className="min-w-0 flex-1" />
        {message && <span className="text-xs text-zinc-500">{message}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={openCopy}>复制类型</Button>
          <Button variant="ghost" className="text-red-600" onClick={() => setDeleteOpen(true)}>删除</Button>
          <Button variant="ghost" onClick={leaveEditor} title={docHref ? `回到文档 ${doc}` : '回到类型列表'}>
            {docHref ? '← ' : ''}{backLabel}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:min-h-0 lg:grid lg:grid-cols-[clamp(300px,22vw,400px)_minmax(0,1fr)]">
        <aside className="max-h-[45dvh] space-y-4 overflow-auto border-b border-zinc-200 bg-white p-4 lg:max-h-none lg:border-b-0 lg:border-r">
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">名称</label>
            <Input value={manifest.name} onChange={(e) => setManifest({ ...manifest, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">描述</label>
            <Textarea
              value={manifest.description}
              onChange={(e) => setManifest({ ...manifest, description: e.target.value })}
              rows={3}
              className="min-h-[4.5rem] text-[13px] leading-5"
              placeholder="这一类文档是给谁看、要解决什么问题（会原样进系统提示词的「当前任务」段）"
            />
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-500">技能（平铺勾选）</p>
            <div className="space-y-0.5">
              {skills.length === 0 && <p className="text-xs text-zinc-400">未发现技能（~/.agents/skills）</p>}
              {skills.map((s) => (
                <label key={s.name} className="flex items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-zinc-50">
                  <Checkbox
                    checked={manifest.skills.includes(s.name)}
                    disabled={!s.enabled}
                    onChange={() => toggle('skills', s.name)}
                  />
                  <span className={s.enabled ? '' : 'text-zinc-400'}>{s.name}</span>
                  <span className="text-[10.5px] text-zinc-400">{s.origin === 'personal' ? '个人' : '项目'}</span>
                  {!s.enabled && <span className="text-[10.5px] text-amber-600">全局停用</span>}
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-500">MCP</p>
            <div className="space-y-0.5">
              {mcp.length === 0 && <p className="text-xs text-zinc-400">尚未配置 MCP</p>}
              {mcp.map((m) => (
                <label key={m.name} className="flex items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-zinc-50">
                  <Checkbox
                    checked={manifest.mcp.includes(m.name)}
                    disabled={!m.enabled}
                    onChange={() => toggle('mcp', m.name)}
                  />
                  <span className={m.enabled ? '' : 'text-zinc-400'}>{m.name}</span>
                  <span className="text-[10.5px] text-zinc-400">{m.transport}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-500">资源文件</p>
            {manifest.resources.length === 0 ? (
              <p className="text-xs text-zinc-400">暂无资源（M5 后续接入文件树管理器）</p>
            ) : (
              <ul className="space-y-1">
                {manifest.resources.map((r) => (
                  <li key={r.path} className="rounded border border-zinc-200 px-2 py-1 font-mono text-[11.5px]">{r.path}</li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex min-h-[50dvh] min-w-0 flex-col p-3 sm:p-4 lg:min-h-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Tabs value={tab} onValueChange={setTab} items={[{ value: 'prompt', label: '提示词' }, { value: 'preview', label: '注入预览' }]} />
            <span className="flex-1" />
            <Badge className="bg-amber-50 text-amber-700">影响进行中会话 · 下一轮生效</Badge>
          </div>
          {tab === 'prompt' ? (
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[45vh] flex-1 resize-none font-mono text-[12px] leading-6 lg:min-h-0"
              placeholder="写下这一类文档的方法论…"
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-500">
                <span className="font-medium text-zinc-700">模型这一轮实际收到的完整系统提示词</span>
                {preview && <Badge>{preview.chars} 字符</Badge>}
                {preview && <Badge>{preview.tools.length} 工具</Badge>}
                {preview && <Badge>{preview.resources.length} 资源</Badge>}
                {preview && <Badge>{preview.mcpServers.length} MCP</Badge>}
                {previewLoading && <span className="text-zinc-400">装配中…</span>}
                <span className="min-w-0 flex-1" />
                {preview && <span className="max-w-full truncate font-mono text-[10.5px] text-zinc-400">cwd = {preview.cwd}</span>}
              </div>
              <Card className="min-h-0 flex-1 overflow-auto">
                <CardContent>
                  {previewError ? (
                    <p className="text-xs text-red-600">装配失败：{previewError}</p>
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-6 text-zinc-700">
                      {preview ? preview.systemPrompt : '正在按真实装配路径生成…'}
                    </pre>
                  )}
                </CardContent>
              </Card>
              <p className="text-[10.5px] leading-5 text-zinc-400">
                含 pi 默认提示词、工具清单、所选技能、类型方法论（prompt.md）、类型名称与描述、资源清单；cwd 段是装配时的工作目录（从文档进入时即该文档目录）。
              </p>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={copyName !== null}
        title={`复制类型 · ${name}`}
        description="整目录拷贝 type.yaml / prompt.md / resources，然后进入新类型的编辑器"
        onClose={() => setCopyName(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setCopyName(null)}>取消</Button>
            <Button onClick={() => void copyType()} disabled={copying}>{copying ? '复制中…' : '复制并进入'}</Button>
          </>
        }
      >
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">新类型名（目录名，可用中文）</span>
            <Input
              autoFocus
              value={copyName ?? ''}
              onChange={(event) => setCopyName(event.target.value)}
              placeholder="如：技术方案-副本"
            />
          </label>
          {dirty ? (
            <p className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              当前有未保存的改动，复制结果是磁盘上的版本，不含这些改动。
            </p>
          ) : null}
          {copyError ? <p className="text-xs text-red-600">{copyError}</p> : null}
        </div>
      </Dialog>

      <Dialog
        open={deleteOpen}
        title={`删除类型 · ${name}`}
        description="不会真删：目录移到 .trash/types/ 并加时间戳，可手动找回"
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={() => void removeType()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-600">
          删除后，已引用该类型的文档仍保留原 type 字段，但再打开类型编辑器会 404；进行中的会话下一轮生效。
        </p>
      </Dialog>
    </main>
  );
}
