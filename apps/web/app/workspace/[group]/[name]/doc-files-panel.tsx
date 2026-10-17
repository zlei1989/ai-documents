'use client';
import * as React from 'react';
import useSWR from 'swr';
import {
  ArrowLeft,
  Braces,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';
import type { DocFileContent, DocFileListing, DocFileNode } from '@aidocs/contracts';
import { httpJson } from '@aidocs/base';
import { Button, buttonVariants, cn } from '@aidocs/ui';
import { MarkdownPreview } from '../../../docs/markdown';
import { docBase, docFileContentUrl, docFileRawUrl, docFilesUrl } from '../../../_lib/asset-url';

/** 人类可读的文件大小 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? String(Math.round(value)) : value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[index] ?? 'B'}`;
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMarkdown(name: string): boolean {
  return /\.(?:md|markdown)$/i.test(name);
}

function FileGlyph({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg)$/.test(lower)) {
    return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />;
  }
  if (/\.(?:md|markdown|txt|log)$/.test(lower)) {
    return <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />;
  }
  if (/\.(?:json|jsonl|ya?ml|toml|ini)$/.test(lower)) {
    return <Braces className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />;
  }
  return <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />;
}

/** 递归文件树：目录在前，文件行右侧显示大小 */
function FileTree({
  nodes,
  depth,
  expanded,
  onToggle,
  onSelect,
}: {
  nodes: DocFileNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: DocFileNode) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = expanded.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                aria-expanded={open}
                title={node.path}
                style={{ paddingLeft: 8 + depth * 14 }}
                className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-xs text-zinc-600 hover:bg-zinc-100"
              >
                <ChevronRight
                  className={cn('h-3 w-3 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')}
                  aria-hidden="true"
                />
                {open ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                )}
                <span className="min-w-0 truncate">{node.name}</span>
              </button>
              {open && node.children && node.children.length > 0 ? (
                <FileTree nodes={node.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
              ) : null}
            </li>
          );
        }
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => onSelect(node)}
              title={node.path}
              style={{ paddingLeft: 8 + depth * 14 }}
              className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs text-zinc-700 hover:bg-zinc-100"
            >
              <span className="h-3 w-3 shrink-0" aria-hidden="true" />
              <FileGlyph name={node.name} />
              <span className="min-w-0 truncate">{node.name}</span>
              <span className="ml-auto shrink-0 pl-2 text-[10px] text-zinc-400">{formatBytes(node.size ?? 0)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 单个文件详情：元信息 + 文本/Markdown/图片预览，二进制给下载 */
function FilePreview({
  base,
  file,
  content,
  loading,
  error,
  onBack,
  onRefresh,
}: {
  base: string;
  file: DocFileNode;
  content: DocFileContent | undefined;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const rawUrl = docFileRawUrl(base, file.path, file.updatedAt);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
    } catch {
      /* 剪贴板不可用时保持静默 */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5">
        <Button variant="ghost" size="icon" onClick={onBack} title="返回文件列表" aria-label="返回文件列表">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file.name}>
          {file.name}
        </span>
        {copied ? <span className="shrink-0 text-[11px] text-emerald-600">已复制</span> : null}
        <Button variant="ghost" size="icon" onClick={() => void copyPath()} title="复制相对路径" aria-label="复制相对路径">
          <Copy className="h-4 w-4" aria-hidden="true" />
        </Button>
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          title={content?.kind === 'image' ? '新标签打开图片' : '下载 / 新标签打开'}
          aria-label={content?.kind === 'image' ? '新标签打开图片' : '下载文件'}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
        <Button variant="ghost" size="icon" onClick={onRefresh} title="刷新文件" aria-label="刷新文件">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">
        <div className="truncate" title={file.path}>
          {file.path}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span>{formatBytes(file.size ?? 0)}</span>
          {file.updatedAt ? <span>{formatTime(file.updatedAt)}</span> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {loading ? (
          <p className="text-xs text-zinc-400">正在读取文件…</p>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-xs text-red-600">读取文件失败：{error}</p>
            <Button variant="outline" onClick={onRefresh}>
              重试
            </Button>
          </div>
        ) : !content ? null : content.kind === 'image' ? (
          <a href={rawUrl} target="_blank" rel="noreferrer" className="block">
            <img
              src={rawUrl}
              alt={file.name}
              draggable={false}
              className="mx-auto max-h-[70vh] max-w-full rounded-md border border-zinc-200 bg-white object-contain"
            />
          </a>
        ) : content.kind === 'text' ? (
          isMarkdown(file.name) ? (
            content.text?.trim() ? (
              <MarkdownPreview source={content.text} assetBase={base} imageVersion={file.updatedAt} />
            ) : (
              <p className="text-xs text-zinc-400">（文件为空）</p>
            )
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-zinc-700">
              {content.text ?? ''}
            </pre>
          )
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">这个格式暂不支持预览，可以下载到本地查看。</p>
            <a href={rawUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline' })}>
              下载文件
            </a>
          </div>
        )}
        {content?.truncated ? (
          <p className="mt-3 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">文件较大，只展示前 256 KB。</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 创作会话里的「文档文件夹」：树 + 文件详情钻取。
 * 只读；取数放在 App 层，packages/client/ui 只负责展示注入的 ReactNode。
 */
export function DocFilesPanel({
  group,
  name,
  refreshToken,
}: {
  group: string;
  name: string;
  /** AI 每轮结束后 +1：自动刷新树与当前文件 */
  refreshToken?: number;
}) {
  const base = docBase(group, name);
  const {
    data: listing,
    error: treeError,
    isLoading: treeLoading,
    mutate: mutateTree,
  } = useSWR<DocFileListing>(docFilesUrl(base), (url: string) => httpJson<DocFileListing>(url));

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<DocFileNode | null>(null);
  const initialized = React.useRef(false);

  // 首次拿到树时默认展开一级目录；用户手动收起后不再重置
  React.useEffect(() => {
    if (!listing || initialized.current) return;
    initialized.current = true;
    setExpanded(new Set(listing.entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.path)));
  }, [listing]);

  const {
    data: content,
    error: contentError,
    isLoading: contentLoading,
    mutate: mutateContent,
  } = useSWR<DocFileContent>(selected ? docFileContentUrl(base, selected.path) : null, (url: string) =>
    httpJson<DocFileContent>(url),
  );

  const refresh = React.useCallback(() => {
    void mutateTree();
    if (selected) void mutateContent();
  }, [mutateTree, mutateContent, selected]);

  // AI 改完文档后刷新（跳过首次挂载，避免和 useSWR 首拉重复）
  const lastRefresh = React.useRef(refreshToken);
  React.useEffect(() => {
    if (refreshToken === undefined || lastRefresh.current === refreshToken) return;
    lastRefresh.current = refreshToken;
    refresh();
  }, [refresh, refreshToken]);

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (selected) {
    return (
      <FilePreview
        base={base}
        file={selected}
        content={content}
        loading={contentLoading}
        error={contentError ? errorText(contentError) : null}
        onBack={() => setSelected(null)}
        onRefresh={refresh}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-zinc-200 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-zinc-500" title={listing?.root ?? `${group}/${name}`}>
            {listing?.root ?? `${group}/${name}`}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {listing
              ? `${listing.fileCount} 个文件 · ${formatBytes(listing.totalBytes)}`
              : treeLoading
                ? '加载中…'
                : '—'}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} title="刷新文件列表" aria-label="刷新文件列表">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {listing?.truncated ? (
        <p className="border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
          目录内容过多，仅展示前一部分。
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {treeError ? (
          <div className="space-y-2 px-3 py-3">
            <p className="text-xs text-red-600">读取文件列表失败：{errorText(treeError)}</p>
            <Button variant="outline" onClick={refresh}>
              重试
            </Button>
          </div>
        ) : treeLoading && !listing ? (
          <p className="px-3 py-3 text-xs text-zinc-400">正在读取文档文件夹…</p>
        ) : !listing || listing.entries.length === 0 ? (
          <p className="px-3 py-3 text-xs text-zinc-400">文档文件夹还是空的。</p>
        ) : (
          <FileTree
            nodes={listing.entries}
            depth={0}
            expanded={expanded}
            onToggle={toggleDir}
            onSelect={setSelected}
          />
        )}
      </div>
    </div>
  );
}
