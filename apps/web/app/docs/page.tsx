'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Settings, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import useSWR from 'swr';
import { httpJson } from '@aidocs/base';
import { Badge, Button, buttonVariants, Input, PaneResizer, Select, cn, type PaneBounds } from '@aidocs/ui';
import type { ArtifactNode, TypeManifest } from '@aidocs/contracts';
import { MarkdownPreview } from './markdown';
import { ContextMenu } from '../_components/context-menu';
import { Dialog } from '../_components/dialog';
import { typeEditorHref } from '../_lib/doc-nav';
import { settingsTabHref } from '../_lib/settings-tabs';
import { docBase } from '../_lib/asset-url';

interface TypeSummaryView {
  name: string;
  description: string;
  manifest: TypeManifest | null;
  resourceCount: number;
}

interface DocDetailView {
  group: string;
  name: string;
  meta: { title: string; type: string; createdAt: string; updatedAt?: string };
  main: string;
}

interface CommitView {
  sha: string;
  shortSha: string;
  at: string;
  author: string;
  summary: string;
  origin: 'ai' | 'human' | 'other';
}

interface StorageStatusView {
  root: string;
  configured: boolean;
  exists: boolean;
  isRepo: boolean;
  commitCount: number;
  recentCommits: CommitView[];
  dirty: boolean;
}

interface Selection {
  group: string;
  name: string;
}

interface DocTarget extends Selection {
  title: string;
  type: string;
}

function targetOf(node: ArtifactNode): DocTarget {
  return { group: node.group, name: node.name, title: node.title || node.name, type: node.type };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function docUrl(selection: Selection): string {
  return `/api/docs/${encodeURIComponent(selection.group)}/${encodeURIComponent(selection.name)}`;
}

/**
 * 文档列表宽度：默认 clamp(220px, 17vw, 320px)，可拖拽区间同时保证右侧文档区不被挤没。
 * 与创作页共用同一套分栏交互（见 docs/spec/60-ui.md）。
 */
const LAYOUT_KEY = 'aidocs.layout.docs';
const TREE_MIN_W = 200;
const TREE_MAX_W = 640;
const DOC_MIN_W = 480;
/** 把手占位（PaneResizer 的 w-1.5），算文档区最小宽度时要扣掉。 */
const HANDLE_W = 6;

function treeBounds(vw: number): PaneBounds {
  const min = Math.min(TREE_MIN_W, Math.round(vw * 0.35));
  const max = Math.max(min, Math.min(TREE_MAX_W, vw - DOC_MIN_W - HANDLE_W));
  return { min, max };
}

function defaultTreeWidth(): number {
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  return clampTreeWidth(Math.min(320, Math.max(220, vw * 0.17)));
}

function clampTreeWidth(width: number): number {
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const { min, max } = treeBounds(vw);
  return Math.min(max, Math.max(min, Math.round(width)));
}

export default function DocsPage() {
  const router = useRouter();
  const {
    data: nodes,
    error: docsError,
    mutate: mutateDocs,
    isLoading: docsLoading,
  } = useSWR<ArtifactNode[]>('/api/docs', (url: string) => httpJson<ArtifactNode[]>(url));
  const { data: types } = useSWR<TypeSummaryView[]>('/api/types', (url: string) => httpJson<TypeSummaryView[]>(url));
  const { data: status, mutate: mutateStatus } = useSWR<StorageStatusView>('/api/storage/status', (url: string) =>
    httpJson<StorageStatusView>(url),
  );

  const [selection, setSelection] = useState<Selection | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<DocTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ target: DocTarget; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  // null = 客户端尚未确定；首帧由 CSS 的 clamp 默认宽度兜底，避免水合不一致。
  const [treeW, setTreeW] = useState<number | null>(null);

  const persistTreeWidth = useCallback((next: number) => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ treeW: next }));
    } catch {
      /* 隐私模式等写入失败时忽略 */
    }
  }, []);

  // 恢复上次拖拽的文档列表宽度
  useEffect(() => {
    let saved: number | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as { treeW?: unknown } | null;
      if (typeof raw?.treeW === 'number' && Number.isFinite(raw.treeW)) saved = raw.treeW;
    } catch {
      /* 本地记录损坏时回落默认宽度 */
    }
    setTreeW(saved === null ? defaultTreeWidth() : clampTreeWidth(saved));
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, ArtifactNode[]>();
    for (const node of nodes ?? []) {
      const list = map.get(node.group) ?? [];
      list.push(node);
      map.set(node.group, list);
    }
    return [...map.entries()].map(([group, items]) => ({ group, items }));
  }, [nodes]);

  const detailKey = selection ? docUrl(selection) : null;
  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
  } = useSWR<DocDetailView>(detailKey, (url: string) => httpJson<DocDetailView>(url));

  // 首次加载自动选中第一篇
  useEffect(() => {
    if (!selection && nodes && nodes.length > 0) {
      const first = nodes[0];
      if (first) setSelection({ group: first.group, name: first.name });
    }
  }, [nodes, selection]);

  // 切文档时清掉上一轮的错误提示
  useEffect(() => {
    setError(null);
  }, [selection?.group, selection?.name]);

  function select(next: Selection): void {
    setSelection(next);
    setTreeOpen(false);
  }

  function toggleGroup(group: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  /** 右键文档 → 记录目标与指针位置，菜单在页面级渲染以免被左栏的 transform 影响定位 */
  function openMenu(event: React.MouseEvent<HTMLButtonElement>, node: ArtifactNode): void {
    event.preventDefault();
    setMenu({ target: targetOf(node), x: event.clientX, y: event.clientY });
  }

  function openRename(target: DocTarget): void {
    setRenameTarget(target);
    setRenameValue(target.name);
    setRenameError(null);
  }

  /** 右键「编辑」与右栏「编辑」一致：进入创作页的文档编辑器 */
  function openWorkspace(target: DocTarget): void {
    router.push(`/workspace/${encodeURIComponent(target.group)}/${encodeURIComponent(target.name)}`);
  }

  /** 文档 → 类型编辑器：带上 ?doc，编辑器里的「回到文档」才能直达这篇文档 */
  function openTypeEditor(target: DocTarget): void {
    if (!target.type) {
      router.push(settingsTabHref('types'));
      return;
    }
    router.push(typeEditorHref(target.type, `${target.group}/${target.name}`));
  }

  function openDelete(target: DocTarget): void {
    setDeleteError(null);
    setDeleteTarget(target);
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget || renaming) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameError('文档名不能为空');
      return;
    }
    if (nextName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const wasSelected = selection?.group === renameTarget.group && selection?.name === renameTarget.name;
    setRenaming(true);
    setRenameError(null);
    try {
      const updated = await httpJson<DocDetailView>(docUrl(renameTarget), {
        method: 'PUT',
        body: JSON.stringify({ name: nextName }),
      });
      setRenameTarget(null);
      await mutateDocs();
      await mutateStatus();
      if (wasSelected) setSelection({ group: updated.group, name: updated.name });
    } catch (renameFailure) {
      setRenameError(errorText(renameFailure));
    } finally {
      setRenaming(false);
    }
  }

  /** 删除目标文档：服务端直接删掉目录，并在版本仓库里留一次删除提交（可从历史恢复） */
  async function handleDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target) return;
    const wasSelected = selection?.group === target.group && selection?.name === target.name;
    setDeleting(true);
    setDeleteError(null);
    try {
      await httpJson<{ ok: boolean }>(docUrl(target), { method: 'DELETE' });
      setDeleteTarget(null);
      const nextNodes = await mutateDocs();
      await mutateStatus();
      if (wasSelected) {
        const next = nextNodes?.[0];
        setSelection(next ? { group: next.group, name: next.name } : null);
      }
    } catch (deleteFailure) {
      setDeleteError(errorText(deleteFailure));
    } finally {
      setDeleting(false);
    }
  }

  async function handleInitStorage(): Promise<void> {
    setInitializing(true);
    setError(null);
    try {
      await httpJson<StorageStatusView>('/api/storage/init', { method: 'POST' });
      await mutateStatus();
    } catch (initError) {
      setError(errorText(initError));
    } finally {
      setInitializing(false);
    }
  }

  async function handleCreated(created: DocDetailView): Promise<void> {
    setShowCreate(false);
    await mutateDocs();
    await mutateStatus();
    setSelection({ group: created.group, name: created.name });
  }

  const typeNames = (types ?? []).map((type) => type.name);
  const detailPending = detailLoading && !detail;

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-white text-zinc-900">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setTreeOpen(true)}
          className="-ml-1 rounded-md p-1.5 text-sm text-zinc-500 hover:bg-zinc-100 md:hidden"
          aria-label="打开文档列表"
        >
          ☰
        </button>
        <Link href="/" className="text-sm font-semibold tracking-tight hover:opacity-70">
          我的文档
        </Link>
        <span className="text-xs text-zinc-400">/</span>
        <span className="text-sm text-zinc-600">文档</span>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/settings"
            title="设置"
            aria-label="设置"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：文档列表（窄屏为抽屉） */}
        {treeOpen ? (
          <div
            className="fixed inset-0 z-30 bg-black/25 md:hidden"
            onClick={() => setTreeOpen(false)}
            aria-hidden="true"
          />
        ) : null}
        <aside
          style={treeW === null ? undefined : ({ '--tree-w': `${treeW}px` } as CSSProperties)}
          className={cn(
            'fixed inset-y-0 left-0 z-40 flex w-[min(84vw,320px)] flex-col border-r border-zinc-200 bg-white shadow-xl transition-transform duration-200 ease-out',
            'md:static md:z-auto md:w-[var(--tree-w,clamp(220px,17vw,320px))] md:translate-x-0 md:bg-zinc-50/40 md:shadow-none md:transition-none',
            treeOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
            <span className="text-xs font-medium tracking-wide text-zinc-500">文档列表</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowCreate(true)}
                title="新建文档"
                aria-label="新建文档"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
              <button
                type="button"
                onClick={() => setTreeOpen(false)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 md:hidden"
                aria-label="关闭文档列表"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {docsLoading && !nodes ? <p className="px-2 py-1 text-xs text-zinc-400">加载中…</p> : null}
            {docsError ? <p className="px-2 py-1 text-xs text-red-600">{errorText(docsError)}</p> : null}
            {!docsLoading && !docsError && groups.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-relaxed text-zinc-400">还没有文档。点上方「＋」新建。</p>
            ) : null}
            {groups.map(({ group, items }) => {
              const isCollapsed = collapsed.has(group);
              return (
                <div key={group} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group)}
                    className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium text-zinc-500 hover:bg-zinc-100"
                  >
                    <span className="w-3 text-[10px] text-zinc-400">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="truncate">{group}</span>
                    <span className="ml-auto text-[10px] text-zinc-400">{items.length}</span>
                  </button>
                  {isCollapsed
                    ? null
                    : items.map((item) => {
                        const active = selection?.group === item.group && selection?.name === item.name;
                        const contextActive =
                          menu?.target.group === item.group && menu.target.name === item.name;
                        return (
                          <button
                            key={item.name}
                            type="button"
                            title={item.name}
                            onClick={() => select({ group: item.group, name: item.name })}
                            onContextMenu={(event) => openMenu(event, item)}
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px]',
                              active
                                ? 'bg-zinc-900 text-zinc-50'
                                : contextActive
                                  ? 'bg-zinc-200 text-zinc-900'
                                  : 'text-zinc-700 hover:bg-zinc-100',
                            )}
                          >
                            <span className="truncate">{item.title || item.name}</span>
                          </button>
                        );
                      })}
                </div>
              );
            })}
          </div>
        </aside>

        {/* 拖拽把手：仅桌面分栏生效，窄屏文档列表是抽屉 */}
        <PaneResizer
          edge="start"
          width={treeW}
          onChange={setTreeW}
          onCommit={persistTreeWidth}
          defaultWidth={defaultTreeWidth}
          bounds={treeBounds}
          label="拖动调整文档列表宽度（双击复位）"
          className="hidden md:block"
        />

        {/* 右栏：文档预览 / 编辑 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 px-3 py-2 sm:px-4">
            {detail ? (
              <>
                <div className="flex min-w-0 max-w-full items-center gap-1.5 text-sm">
                  <span className="truncate text-zinc-500">{detail.group}</span>
                  <span className="text-zinc-300">/</span>
                  <span className="truncate font-medium text-zinc-900">{detail.meta.title}</span>
                </div>
                <Badge>{detail.meta.type}</Badge>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Link
                    href={`/workspace/${encodeURIComponent(detail.group)}/${encodeURIComponent(detail.name)}`}
                    title="编辑"
                    aria-label="编辑"
                    className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  >
                    <SquarePen className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </div>
              </>
            ) : (
              <span className="text-sm text-zinc-400">
                {detailPending ? '加载中…' : selection ? '文档加载失败' : '选择或新建一篇文档'}
              </span>
            )}
          </div>

          {/* 最近提交 */}
          <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 bg-zinc-50/70 px-3 py-1 text-[11px] text-zinc-500 sm:px-4">
            {status?.isRepo ? (
              <>
                <span className="whitespace-nowrap text-zinc-600">⎇ {status.commitCount} 个版本</span>
                <span className="min-w-0 flex-1 truncate">
                  最近提交：
                  {status.recentCommits.length > 0
                    ? status.recentCommits
                        .slice(0, 3)
                        .map((commit) => `${commit.shortSha} ${commit.summary}（${formatTime(commit.at)}）`)
                        .join(' · ')
                    : '暂无提交'}
                </span>
              </>
            ) : (
              <>
                <span className="whitespace-nowrap">版本历史未初始化</span>
                <Button
                  variant="outline"
                  onClick={handleInitStorage}
                  disabled={initializing || !status?.configured}
                >
                  {initializing ? '初始化中…' : '初始化版本历史'}
                </Button>
              </>
            )}
          </div>

          {status && !status.configured ? (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              尚未配置 storageRoot，请先到{' '}
              <Link href="/settings" className="underline">
                设置
              </Link>{' '}
              填写存储根目录。
            </div>
          ) : null}
          {error ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">{error}</div>
          ) : null}
          {!error && detailError ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">{errorText(detailError)}</div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-10">
            {detail ? (
              <MarkdownPreview
                source={detail.main}
                assetBase={docBase(detail.group, detail.name)}
                openArchifyOnClick
              />
            ) : (
              <div className="text-sm text-zinc-400">
                {detailPending ? '正在读取 MAIN.md…' : '从左侧选择一篇文档，或点「＋」新建。'}
              </div>
            )}
          </div>
        </section>
      </div>

      {renameTarget ? (
        <Dialog
          open
          title={`重命名文档 · ${renameTarget.title}`}
          description={`${renameTarget.group} / ${renameTarget.name}`}
          onClose={() => {
            if (!renaming) setRenameTarget(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>
                取消
              </Button>
              <Button
                onClick={() => void submitRename()}
                disabled={renaming || !renameValue.trim() || renameValue.trim() === renameTarget.name}
              >
                {renaming ? '重命名中…' : '重命名'}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
            className="space-y-2 text-sm"
          >
            <label className="block space-y-1">
              <span className="text-xs text-zinc-500">文档名（即目录名，可用中文）</span>
              <Input
                autoFocus
                value={renameValue}
                disabled={renaming}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </label>
            <p className="text-xs text-zinc-500">不能包含 / \ 等路径符号，不能以 . 开头，最多 80 字。</p>
            {renameError ? <p className="text-xs text-red-600">重命名失败：{renameError}</p> : null}
          </form>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          open
          title={`删除文档 · ${deleteTarget.title}`}
          description={`${deleteTarget.group} / ${deleteTarget.name}`}
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? '删除中…' : '删除文档'}
              </Button>
            </>
          }
        >
          <div className="space-y-2 text-sm leading-relaxed text-zinc-600">
            <p>确定要删除这篇文档吗？</p>
            <p>
              文档目录会直接删除；版本仓库里会留一次「删除文档」提交，内容可随时从历史恢复。
            </p>
            {deleteError ? <p className="text-xs text-red-600">删除失败：{deleteError}</p> : null}
          </div>
        </Dialog>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`文档「${menu.target.title}」的操作`}
          onClose={() => setMenu(null)}
          items={[
            { label: '重命名', onSelect: () => openRename(menu.target) },
            { label: '编辑', onSelect: () => openWorkspace(menu.target) },
            { label: '类型编辑 ↗', onSelect: () => openTypeEditor(menu.target) },
            { label: '删除', danger: true, onSelect: () => openDelete(menu.target) },
          ]}
        />
      ) : null}

      {showCreate ? (
        <NewDocDialog
          groups={groups.map((group) => group.group)}
          types={typeNames}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </main>
  );
}

function NewDocDialog({
  groups,
  types,
  onClose,
  onCreated,
}: {
  groups: string[];
  types: string[];
  onClose: () => void;
  onCreated: (detail: DocDetailView) => Promise<void> | void;
}) {
  const [groupChoice, setGroupChoice] = useState(groups[0] ?? '__new__');
  const [newGroup, setNewGroup] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState(types[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const group = groupChoice === '__new__' ? newGroup.trim() : groupChoice;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!group || !name.trim() || !type) {
      setError('请填写分组与文档名，并选择类型');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await httpJson<DocDetailView>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ group, name: name.trim(), type }),
      });
      await onCreated(created);
    } catch (createError) {
      setError(errorText(createError));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="w-[min(100%,32rem)] rounded-lg border border-zinc-200 bg-white p-5 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="新建文档"
      >
        <h2 className="mb-4 text-base font-semibold">新建文档</h2>
        <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">分组</span>
            <Select value={groupChoice} onChange={(event) => setGroupChoice(event.target.value)}>
              {groups.map((groupName) => (
                <option key={groupName} value={groupName}>
                  {groupName}
                </option>
              ))}
              <option value="__new__">＋ 新建分组…</option>
            </Select>
          </label>
          {groupChoice === '__new__' ? (
            <label className="block space-y-1">
              <span className="text-xs text-zinc-500">新分组名</span>
              <Input autoFocus value={newGroup} onChange={(event) => setNewGroup(event.target.value)} placeholder="如：产品" />
            </label>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">文档名（即目录名，可用中文）</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="如：文档生成应用" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">类型</span>
            {types.length > 0 ? (
              <Select value={type} onChange={(event) => setType(event.target.value)}>
                {types.map((typeName) => (
                  <option key={typeName} value={typeName}>
                    {typeName}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                还没有类型。类型是文档的提示词模板，可先通过 /api/types 创建。
              </p>
            )}
          </label>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || types.length === 0}>
              {busy ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
