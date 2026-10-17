'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, GitBranch, MessageSquare, SquarePen, Type, X } from 'lucide-react';
import type { GeneratedImage, GitCommit, Selection } from '@aidocs/contracts';
import { httpJson } from '@aidocs/base';
import { Badge, Button, buttonVariants, ChatPanel, cn } from '@aidocs/ui';
import { ContextMenu } from '../../../_components/context-menu';
import { typeEditorHref } from '../../../_lib/doc-nav';
import { settingsTabHref } from '../../../_lib/settings-tabs';
import { archifySourcePath, archifyViewUrl, assetUrl, diagramMarkdownRef, docBase, normalizeAssetPath } from '../../../_lib/asset-url';
import { MarkdownPreview, type MarkdownImageInfo } from '../../../docs/markdown';
import { ArchifyEditor } from './archify-editor';
import { DocFilesPanel } from './doc-files-panel';

const KEY = 'aidocs.layout.workspace';
const MIN_CHAT_W = 300;
const MAX_CHAT_W = 960;
/** 桌面断点：≥ 此宽度聊天栏在流内可拖拽，窄于此为覆盖式抽屉 */
const DESKTOP_QUERY = '(min-width: 1024px)';

function chatBounds(): { min: number; max: number } {
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const min = Math.min(MIN_CHAT_W, Math.round(vw * 0.5));
  const max = Math.max(min, Math.min(MAX_CHAT_W, Math.round(vw * 0.5)));
  return { min, max };
}

function clampChatWidth(width: number): number {
  const { min, max } = chatBounds();
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** 聊天栏默认占视口约 28%，并随屏宽钳制在 300–960px。 */
function defaultChatWidth(): number {
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  return clampChatWidth(vw * 0.28);
}

export function WorkspaceShell({
  group,
  name,
  text,
  typeName,
  typeExists,
}: {
  group: string;
  name: string;
  text: string;
  typeName: string;
  /** typeName 对应的类型目录是否存在；false 时入口仍可点，但会落到「创建该类型」页 */
  typeExists: boolean;
}) {
  const [chatW, setChatW] = React.useState(380);
  const [collapsed, setCollapsed] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  // 文档文件夹视图：替换消息流 + 输入框，按钮在 ChatPanel 头部
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [isDesktop, setIsDesktop] = React.useState(true);
  const dragRef = React.useRef<{ startX: number; startW: number } | null>(null);
  const [gitOpen, setGitOpen] = React.useState(false);
  // 图片右键菜单与图示编辑器；imageEpoch 用于保存后让预览图片重新请求。
  const [imageMenu, setImageMenu] = React.useState<{ x: number; y: number; info: MarkdownImageInfo } | null>(null);
  // 消息流里的生图结果：右键菜单 + 页面级放大遮罩
  const [chatImageMenu, setChatImageMenu] = React.useState<{ x: number; y: number; image: GeneratedImage } | null>(null);
  const [previewImage, setPreviewImage] = React.useState<GeneratedImage | null>(null);
  const [archifyEditor, setArchifyEditor] = React.useState<{
    sourcePath: string;
    alt: string;
  } | null>(null);
  const [imageEpoch, setImageEpoch] = React.useState(0);
  const router = useRouter();
  // 「编辑原文」：正文区在预览与 textarea 之间切换，保存写回 MAIN.md 后刷新服务端数据。
  const [editingSource, setEditingSource] = React.useState(false);
  const [draft, setDraft] = React.useState(text);
  const [savingSource, setSavingSource] = React.useState(false);
  const [sourceError, setSourceError] = React.useState<string | null>(null);
  // 选区上下文缓存：正文/原文里右键加入，随下一条消息一起发，发完即清空。
  const [selections, setSelections] = React.useState<Selection[]>([]);
  const [selectionMenu, setSelectionMenu] = React.useState<{ x: number; y: number; text: string } | null>(null);
  const [selectionToast, setSelectionToast] = React.useState<{ id: number; text: string } | null>(null);
  const selectionToastId = React.useRef(0);
  const previewRef = React.useRef<HTMLElement>(null);
  const selectionChars = selections.reduce((sum, selection) => sum + selection.chars, 0);
  const docUrl = `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  // 稳定的回调：ChatPanel 的 SSE effect 依赖它，内联箭头函数会让消息流反复重连。
  const refreshDoc = React.useCallback(() => router.refresh(), [router]);
  // AI 每轮结束/图示保存后都 +1：既刷新文档，也让既有 SVG 图片绕过浏览器缓存。
  const handleDocUpdated = React.useCallback(() => {
    setImageEpoch((value) => value + 1);
    refreshDoc();
  }, [refreshDoc]);

  /** 消息流生图结果 → 本地代理地址（只在渲染时拼，不写进文档） */
  const resolveChatImageUrl = React.useCallback(
    (path: string) => {
      const normalized = normalizeAssetPath(path);
      return normalized ? assetUrl(docBase(group, name), normalized, imageEpoch) : '';
    },
    [group, name, imageEpoch],
  );

  React.useEffect(() => {
    if (!previewImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewImage]);

  React.useEffect(() => {
    if (!selectionToast) return;
    const timer = setTimeout(() => setSelectionToast(null), 2400);
    return () => clearTimeout(timer);
  }, [selectionToast]);

  function flashSelectionToast(message: string): void {
    selectionToastId.current += 1;
    setSelectionToast({ id: selectionToastId.current, text: message });
  }

  /**
   * 加入一处上下文：正文/原文的选区，或右键图片得到的 Markdown 引用。
   * about 只影响提示文案——图片说「图示「标题」」，选区说字数。
   */
  function addSelection(raw: string, about?: { noun: string; name?: string }): void {
    const selectionText = raw.replace(/\r\n/g, '\n').trim();
    if (!selectionText) return;
    const label = about ? `${about.noun}${about.name ? `「${about.name}」` : ''}` : null;
    if (selections.some((selection) => selection.text === selectionText)) {
      flashSelectionToast(`${label ?? '该选区'}已在上下文中（共 ${selections.length} 处）`);
      return;
    }
    const next: Selection[] = [
      ...selections,
      {
        source: 'MAIN.md',
        chars: selectionText.length,
        preview: selectionText.replace(/\s+/g, ' ').slice(0, 80),
        text: selectionText,
      },
    ];
    setSelections(next);
    flashSelectionToast(
      label
        ? `已加入上下文：${label}（共 ${next.length} 处）`
        : `已加入上下文 ${selectionText.length} 字（共 ${next.length} 处）`,
    );
  }

  /** 预览图片右键：记录位置与图片信息，由页面级 ContextMenu 接管 */
  const openImageMenu = React.useCallback((event: React.MouseEvent<HTMLElement>, info: MarkdownImageInfo) => {
    setImageMenu({ x: event.clientX, y: event.clientY, info });
  }, []);

  /** 正文区右键：只有当前选区落在预览里才接管，否则保留浏览器原生菜单。 */
  function openPreviewSelectionMenu(event: React.MouseEvent): void {
    if (event.defaultPrevented) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!previewRef.current?.contains(range.commonAncestorContainer)) return;
    const selected = selection.toString();
    if (!selected.trim()) return;
    event.preventDefault();
    setSelectionMenu({ x: event.clientX, y: event.clientY, text: selected });
  }

  /** 原文编辑器右键：textarea 没有 DOM Selection，读 selectionStart/End。 */
  function openSourceSelectionMenu(event: React.MouseEvent<HTMLTextAreaElement>): void {
    const element = event.currentTarget;
    if (element.selectionStart === element.selectionEnd) return;
    const selected = element.value.slice(element.selectionStart, element.selectionEnd);
    if (!selected.trim()) return;
    event.preventDefault();
    setSelectionMenu({ x: event.clientX, y: event.clientY, text: selected });
  }

  async function copySelection(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板不可用时保持静默，⌘/Ctrl+C 仍可用 */
    }
  }

  function startEditingSource(): void {
    setDraft(text);
    setSourceError(null);
    setEditingSource(true);
  }

  /** 取消编辑：丢弃草稿回到预览；有未保存修改时先确认（与其它编辑器的离开提醒一致）。 */
  function cancelEditingSource(): void {
    if (draft !== text && !window.confirm('有未保存的修改，确定放弃编辑？')) return;
    setDraft(text);
    setSourceError(null);
    setEditingSource(false);
  }

  // 保存只写 MAIN.md（服务端 saveMain 不做 git 提交/推送），成功后退出编辑态。
  const saveSource = React.useCallback(async (): Promise<void> => {
    if (savingSource) return;
    setSavingSource(true);
    setSourceError(null);
    try {
      await httpJson(docUrl, { method: 'PUT', body: JSON.stringify({ main: draft }) });
      setEditingSource(false);
      router.refresh();
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSource(false);
    }
  }, [docUrl, draft, router, savingSource]);

  // 编辑态独占：⌘/Ctrl+S 保存；未保存修改时拦截刷新/关闭。
  React.useEffect(() => {
    if (!editingSource) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void saveSource();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draft === text) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [draft, editingSource, saveSource, text]);

  React.useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { chatW?: number; collapsed?: boolean } | null;
      setChatW(saved?.chatW ? clampChatWidth(saved.chatW) : defaultChatWidth());
      if (typeof saved?.collapsed === 'boolean') setCollapsed(saved.collapsed);
    } catch {
      setChatW(defaultChatWidth());
    }

    const mq = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // 窗口尺寸变化时保持聊天栏在合理比例内；回到桌面宽度时收起移动端抽屉状态。
  React.useEffect(() => {
    const onResize = () => {
      setChatW((prev) => clampChatWidth(prev));
      if (window.matchMedia(DESKTOP_QUERY).matches) setChatOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persist = React.useCallback((nextW: number, nextCollapsed: boolean) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ chatW: nextW, collapsed: nextCollapsed }));
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'j') return;
      e.preventDefault();
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        setCollapsed((prev) => {
          const next = !prev;
          persist(chatW, next);
          return next;
        });
      } else {
        setChatOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatW, persist]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: chatW };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setChatW(clampChatWidth(dragRef.current.startW - (e.clientX - dragRef.current.startX)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    persist(chatW, collapsed);
  };

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-3 py-2 sm:px-4">
        {!editingSource ? (
          <Link href="/docs" className="text-xs text-zinc-500 hover:text-zinc-900">← 文档</Link>
        ) : null}
        <span className="min-w-0 truncate text-xs text-zinc-400">{group} /</span>
        <span className="max-w-full truncate text-sm font-medium">{name}</span>
        <Badge title={typeExists ? undefined : `类型「${typeName}」目录不存在，可点「编辑类型」创建`}>
          {typeName || '无类型'}
          {typeName && !typeExists ? ' · 缺失' : ''}
        </Badge>
        {editingSource ? (
          <span className="text-xs text-zinc-400">编辑中 · ⌘/Ctrl+S 保存</span>
        ) : null}
        {selections.length > 0 ? (
          <Badge className="bg-emerald-50 text-emerald-700" title="随下一条消息发送，发送后自动清空">
            上下文 {selections.length} 处 · {selectionChars} 字
          </Badge>
        ) : null}
        {selectionToast ? (
          <span key={selectionToast.id} className="text-[11px] text-emerald-600">
            {selectionToast.text}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {editingSource ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={cancelEditingSource}
              disabled={savingSource}
              title="放弃本次修改，回到预览"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              取消
            </Button>
            <Button
              onClick={() => void saveSource()}
              disabled={savingSource}
              title="⌘/Ctrl+S 保存（只写文件，不提交 git）"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {savingSource ? '保存中…' : '保存'}
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="ghost" className="lg:hidden" onClick={() => setChatOpen(true)}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              会话
            </Button>
            <Button variant="ghost" onClick={() => setGitOpen(true)}>
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
              版本
            </Button>
            <Button variant="ghost" onClick={startEditingSource}>
              <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
              编辑原文
            </Button>
            {typeName ? (
              <Link
                href={typeEditorHref(typeName, `${group}/${name}`)}
                className={buttonVariants({ variant: 'ghost' })}
                title={
                  typeExists
                    ? `带着返回地址进入类型「${typeName}」编辑器`
                    : `类型「${typeName}」目录缺失，进入后可一键创建`
                }
              >
                <Type className="h-3.5 w-3.5" aria-hidden="true" />
                编辑类型
              </Link>
            ) : (
              <Link href={settingsTabHref('types')} className={cn(buttonVariants({ variant: 'ghost' }), 'text-amber-600')}>
                <Type className="h-3.5 w-3.5" aria-hidden="true" />
                文档无类型 · 去设置
              </Link>
            )}
          </div>
        )}
      </header>

      {sourceError ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 sm:px-4">
          保存失败：{sourceError}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        <section
          className={cn(
            'min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 xl:px-12',
            editingSource ? 'flex min-h-0 flex-col' : 'overflow-auto',
          )}
        >
          {editingSource ? (
            <textarea
              aria-label="编辑 MAIN.md 原文"
              autoFocus
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onContextMenu={openSourceSelectionMenu}
              className="min-h-0 flex-1 resize-none rounded-md border border-zinc-200 bg-white p-3 font-mono text-[13px] leading-relaxed text-zinc-800 outline-none focus:ring-2 focus:ring-zinc-300"
            />
          ) : (
            <article
              ref={previewRef}
              onContextMenu={openPreviewSelectionMenu}
              className="w-full max-w-none break-words text-[clamp(14px,0.5vw+7px,17px)] leading-[1.8] text-zinc-800"
            >
              <MarkdownPreview
                source={text}
                assetBase={docBase(group, name)}
                imageVersion={imageEpoch}
                onImageContextMenu={openImageMenu}
              />
            </article>
          )}
        </section>

        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => {
              const resetW = defaultChatWidth();
              setChatW(resetW);
              persist(resetW, collapsed);
            }}
            className="hidden w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-zinc-300/60 lg:block"
            title="拖动调整聊天栏宽度（双击复位）"
          />
        )}

        {chatOpen ? (
          <div
            className="fixed inset-0 z-30 bg-black/25 lg:hidden"
            onClick={() => setChatOpen(false)}
            aria-hidden="true"
          />
        ) : null}

        <div
          style={{ '--chat-w': `${chatW}px` } as React.CSSProperties}
          className={cn(
            'fixed inset-y-0 right-0 z-40 min-h-0 shrink-0 bg-white shadow-2xl transition-transform duration-200 ease-out',
            'w-[min(92vw,420px)] lg:static lg:z-auto lg:w-[var(--chat-w)] lg:translate-x-0 lg:shadow-none lg:transition-none',
            chatOpen ? 'translate-x-0' : 'translate-x-full',
            collapsed && 'lg:w-[46px]',
          )}
        >
          <ChatPanel
            group={group}
            name={name}
            selections={selections}
            onSelectionsSent={() => {
              setSelections([]);
              flashSelectionToast('上下文已随消息发送');
            }}
            onRemoveSelection={(index) => {
              setSelections((prev) => prev.filter((_, i) => i !== index));
              setSelectionToast(null);
            }}
            onClearSelections={() => {
              setSelections([]);
              setSelectionToast(null);
            }}
            collapsed={isDesktop ? collapsed : false}
            onDocUpdated={handleDocUpdated}
            resolveImageUrl={resolveChatImageUrl}
            onImageOpen={(image) => setPreviewImage(image)}
            onImageContextMenu={(event, image) => {
              event.preventDefault();
              event.stopPropagation();
              setChatImageMenu({ x: event.clientX, y: event.clientY, image });
            }}
            onToggleCollapse={() => {
              if (window.matchMedia(DESKTOP_QUERY).matches) {
                const next = !collapsed;
                setCollapsed(next);
                persist(chatW, next);
              } else {
                setChatOpen(false);
              }
            }}
            filesOpen={filesOpen}
            onToggleFiles={() => setFilesOpen((open) => !open)}
            filesPanel={<DocFilesPanel group={group} name={name} refreshToken={imageEpoch} />}
          />
        </div>

        {!chatOpen ? (
          <Button
            className="fixed bottom-4 right-4 z-30 shadow-lg lg:hidden"
            onClick={() => setChatOpen(true)}
          >
            创作会话
          </Button>
        ) : null}
      </div>

      {selectionMenu ? (
        <ContextMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          label="选区操作"
          items={[
            {
              label: `加入对话上下文（${selectionMenu.text.trim().length} 字）`,
              onSelect: () => addSelection(selectionMenu.text),
            },
            { label: '复制', onSelect: () => void copySelection(selectionMenu.text) },
          ]}
          onClose={() => setSelectionMenu(null)}
        />
      ) : null}

      {imageMenu ? (
        <ContextMenu
          x={imageMenu.x}
          y={imageMenu.y}
          label={`图片「${imageMenu.info.alt || imageMenu.info.path}」的操作`}
          onClose={() => setImageMenu(null)}
          items={[
            {
              label: '加入对话上下文',
              onSelect: () =>
                addSelection(diagramMarkdownRef(imageMenu.info.alt, imageMenu.info.path), {
                  noun: '图示',
                  name: imageMenu.info.alt || imageMenu.info.path,
                }),
            },
            ...(imageMenu.info.archify
              ? [
                  {
                    label: '打开交互图示',
                    onSelect: () => {
                      const sourcePath = archifySourcePath(imageMenu.info.path);
                      window.open(archifyViewUrl(docBase(group, name), sourcePath, undefined, false), '_blank', 'noopener,noreferrer');
                      setImageMenu(null);
                    },
                  },
                  {
                    label: '编辑 JSON',
                    onSelect: () => {
                      setArchifyEditor({
                        sourcePath: archifySourcePath(imageMenu.info.path),
                        alt: imageMenu.info.alt,
                      });
                      setImageMenu(null);
                    },
                  },
                ]
              : []),
            {
              label: '复制图片路径',
              onSelect: () => {
                void copySelection(imageMenu.info.path);
                setImageMenu(null);
              },
            },
            {
              label: '复制 Markdown 引用',
              onSelect: () => {
                void copySelection(diagramMarkdownRef(imageMenu.info.alt, imageMenu.info.path));
                setImageMenu(null);
              },
            },
          ]}
        />
      ) : null}

      {chatImageMenu ? (
        <ContextMenu
          x={chatImageMenu.x}
          y={chatImageMenu.y}
          label={`图片「${chatImageMenu.image.alt || chatImageMenu.image.path}」的操作`}
          onClose={() => setChatImageMenu(null)}
          items={[
            {
              label: '加入对话上下文',
              onSelect: () =>
                addSelection(diagramMarkdownRef(chatImageMenu.image.alt, chatImageMenu.image.path), {
                  noun: '图片',
                  name: chatImageMenu.image.alt || chatImageMenu.image.path,
                }),
            },
            {
              label: '查看大图',
              onSelect: () => setPreviewImage(chatImageMenu.image),
            },
            {
              label: '复制 Markdown 引用',
              onSelect: () =>
                void copySelection(diagramMarkdownRef(chatImageMenu.image.alt, chatImageMenu.image.path)),
            },
          ]}
        />
      ) : null}

      {previewImage ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`图片「${previewImage.alt || previewImage.path}」`}
          className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-zinc-950/85 p-6"
          onClick={() => setPreviewImage(null)}
        >
          <button
            type="button"
            aria-label="关闭大图"
            onClick={() => setPreviewImage(null)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={resolveChatImageUrl(previewImage.path)}
            alt={previewImage.alt}
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[86vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
          />
          <div
            className="flex max-w-[90vw] flex-wrap items-center gap-3 text-xs text-zinc-200"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="max-w-[60vw] truncate">{previewImage.alt || previewImage.path}</span>
            {previewImage.size ? <span className="text-zinc-400">{previewImage.size}</span> : null}
            <a
              href={resolveChatImageUrl(previewImage.path)}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-white"
            >
              在新标签打开
            </a>
          </div>
        </div>
      ) : null}

      {archifyEditor ? (
        <ArchifyEditor
          group={group}
          name={name}
          sourcePath={archifyEditor.sourcePath}
          alt={archifyEditor.alt}
          onClose={() => setArchifyEditor(null)}
          onSaved={() => setImageEpoch((value) => value + 1)}
        />
      ) : null}

      {gitOpen && <GitSheet group={group} name={name} onClose={() => setGitOpen(false)} />}
    </main>
  );
}

function GitSheet({ group, name, onClose }: { group: string; name: string; onClose: () => void }) {
  const [commits, setCommits] = React.useState<GitCommit[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/git/log?group=${encodeURIComponent(group)}&name=${encodeURIComponent(name)}`);
      const json = (await res.json()) as { commits?: GitCommit[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCommits(json.commits ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [group, name]);

  React.useEffect(() => { void load(); }, [load]);

  async function showDiff(sha: string) {
    setDiff('加载中…');
    const res = await fetch(`/api/git/diff?group=${encodeURIComponent(group)}&name=${encodeURIComponent(name)}&sha=${sha}`);
    const json = (await res.json()) as { diff?: string; error?: string };
    setDiff(res.ok ? json.diff ?? '(无变更)' : `失败：${json.error}`);
  }

  async function rollback(sha: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/git/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group, name, sha }),
      });
      const json = (await res.json()) as { error?: string; committed?: boolean };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNotice(json.committed === false ? '文档已在该版本，无需回滚' : '已回滚并生成回滚提交');
      await load();
    } catch (e) {
      setNotice(`回滚失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="flex h-full w-[min(560px,92vw)] flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3">
          <span className="text-sm font-medium">版本历史</span>
          <Badge>{commits?.length ?? 0} 个提交</Badge>
          <span className="min-w-0 flex-1" />
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        </header>
        <div className="flex-1 overflow-auto p-3">
          {error && <p className="text-xs text-red-600">{error}</p>}
          {notice && <p className="mb-2 text-xs text-amber-600">{notice}</p>}
          {commits === null && !error && <p className="text-xs text-zinc-400">加载中…</p>}
          {commits?.length === 0 && <p className="text-xs text-zinc-400">还没有提交。AI 每轮修改后会自动提交。</p>}
          <ul className="space-y-2">
            {commits?.map((c) => (
              <li key={c.sha} className="rounded-lg border border-zinc-200 p-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-zinc-500">{c.shortSha}</span>
                  <Badge className={c.origin === 'ai' ? 'bg-emerald-50 text-emerald-700' : ''}>{c.origin === 'ai' ? 'AI' : c.origin === 'human' ? '手动' : '其他'}</Badge>
                  <span className="text-zinc-400">{new Date(c.at).toLocaleString('zh-CN')}</span>
                </div>
                <p className="mt-1 text-[13px]">{c.summary}</p>
                <div className="mt-1.5 flex gap-2">
                  <Button variant="ghost" onClick={() => void showDiff(c.sha)}>看 diff</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void rollback(c.sha)}>回滚到此处</Button>
                </div>
              </li>
            ))}
          </ul>
          {diff && (
            <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2">
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-zinc-700">{diff}</pre>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
