'use client';
import * as React from 'react';
import { Files } from 'lucide-react';
import type { ChatEvent, ChatMessage, GeneratedImage, Selection, SessionStatus } from '@aidocs/contracts';
import { cn } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/input';
import { ClarificationCard } from './clarification-card';
import { GeneratedImagesBlock } from './generated-images';

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '待命',
  running: '创作中…',
  waiting: '等待输入',
  done: '已完成 · 可收起',
  error: '出错',
};

/** 实时思考块：限高滚动，并始终把视口跟到最新一行 */
function ThinkingBlock({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-2 py-1.5">
      <span className="mb-0.5 block text-[10px] tracking-widest text-zinc-400">思考</span>
      <div ref={ref} className="max-h-40 overflow-auto">
        <p className="whitespace-pre-wrap break-words text-[11.5px] italic leading-relaxed text-zinc-500">{text}</p>
      </div>
    </div>
  );
}

export interface ChatPanelProps {
  group: string;
  name: string;
  /** 待发送的选区上下文缓存：正文/原文里右键加入，发送成功后由 onSelectionsSent 清空 */
  selections?: Selection[];
  onSelectionsSent?: () => void;
  onRemoveSelection?: (index: number) => void;
  onClearSelections?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onDocUpdated?: () => void;
  /** 生图结果缩略图 URL；由 App 注入 assetBase/版本，UI 包不拼代理地址 */
  resolveImageUrl?: (path: string) => string;
  /** 点击生图结果：由 App 打开页面级放大遮罩 */
  onImageOpen?: (image: GeneratedImage) => void;
  /** 右键生图结果：由 App 打开上下文菜单 */
  onImageContextMenu?: (event: React.MouseEvent<HTMLElement>, image: GeneratedImage) => void;
  /** 文件管理器是否占据会话主体（由 App 控制） */
  filesOpen?: boolean;
  /** 提供时头部显示「文档文件」切换按钮 */
  onToggleFiles?: () => void;
  /** 文件管理器面板（App 注入；替换消息流 + 输入框） */
  filesPanel?: React.ReactNode;
}

export function ChatPanel({
  group,
  name,
  selections = [],
  onSelectionsSent,
  onRemoveSelection,
  onClearSelections,
  collapsed = false,
  onToggleCollapse,
  onDocUpdated,
  resolveImageUrl,
  onImageOpen,
  onImageContextMenu,
  filesOpen = false,
  onToggleFiles,
  filesPanel,
}: ChatPanelProps) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [status, setStatus] = React.useState<SessionStatus>('idle');
  const [notices, setNotices] = React.useState<string[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const lastStatusRef = React.useRef<SessionStatus | null>(null);
  const selectionChars = selections.reduce((sum, selection) => sum + selection.chars, 0);
  const awaitingClarification = status === 'waiting';

  const url = `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}/events`;

  React.useEffect(() => {
    const es = new EventSource(url);
    const onMessage = (e: MessageEvent) => {
      const event = JSON.parse(e.data) as ChatEvent;
      if (event.type !== 'message') return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.mergeKey === event.message.mergeKey);
        if (idx < 0) return [...prev, event.message];
        const next = [...prev];
        next[idx] = event.message;
        return next;
      });
    };
    const onStatus = (e: MessageEvent) => {
      const event = JSON.parse(e.data) as ChatEvent;
      if (event.type === 'status') {
        const previous = lastStatusRef.current;
        lastStatusRef.current = event.status;
        setStatus(event.status);
        // 回放里最后一条 status=done 不应触发 router.refresh()，否则刷新会再回放、形成循环。
        // 只有在已经看到 running/waiting 之后收到 done，才认为这一轮是实时结束。
        if (event.status === 'done' && previous !== null && previous !== 'done') onDocUpdated?.();
      }
      if (event.type === 'notice') setNotices((prev) => [...prev.slice(-4), event.text]);
    };
    es.addEventListener('message', onMessage);
    es.addEventListener('status', onStatus);
    es.addEventListener('notice', onStatus);
    return () => es.close();
  }, [url, onDocUpdated]);

  // 工具消息里追加 images 块时消息数不变、块数会变；用块数触发一次滚底，让结果可见
  const blockCount = React.useMemo(
    () => messages.reduce((sum, message) => sum + message.blocks.length, 0),
    [messages],
  );

  React.useEffect(() => {
    if (filesOpen) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, blockCount, status, filesOpen]);

  async function send(text: string) {
    const value = text.trim();
    if (!value || busy || awaitingClarification) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value, ...(selections.length ? { selections } : {}) }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      // 上下文只随这一条消息走：发送成功后立刻清空，避免下一轮重复注入。
      if (selections.length) onSelectionsSent?.();
      setInput('');
    } catch (error) {
      setNotices((prev) => [...prev.slice(-4), `发送失败：${(error as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  /** 澄清卡提交：POST 后等待 SSE 把卡片更新为「已答复」，同一轮创作自动继续 */
  async function submitClarification(groupId: string, answers: Record<string, string>): Promise<void> {
    const response = await fetch(
      `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}/clarifications`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId, answers }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex h-full w-full flex-col items-center gap-3 border-l border-zinc-200 bg-white py-3"
        title="展开消息流（⌘J）"
      >
        <span className="text-zinc-400">›</span>
        <span className="[writing-mode:vertical-rl] text-xs tracking-widest text-zinc-400">
          {filesOpen ? '文档文件' : '创作会话'}
        </span>
      </button>
    );
  }

  return (
    <aside className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-zinc-200 bg-white">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
        <span className="text-xs font-medium">{filesOpen ? '文档文件夹' : '创作会话'}</span>
        {filesOpen ? null : (
          <Badge
            className={
              status === 'running' ? 'bg-amber-50 text-amber-700' : status === 'error' ? 'bg-red-50 text-red-700' : ''
            }
          >
            {STATUS_LABEL[status]}
          </Badge>
        )}
        <span className="flex-1" />
        {onToggleFiles ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleFiles}
            title={filesOpen ? '返回创作会话' : '查看文档文件'}
            aria-label={filesOpen ? '返回创作会话' : '查看文档文件'}
            aria-pressed={filesOpen}
            className={cn(filesOpen && 'bg-zinc-100 text-zinc-900')}
          >
            <Files className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" onClick={onToggleCollapse} title="收起（⌘J）">
          ›
        </Button>
      </header>

      {filesOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">{filesPanel}</div>
      ) : (
        <>
      <div ref={listRef} className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="text-xs text-zinc-400">还没有对话。描述你想写的文档，AI 会直接改 MAIN.md；需要图示就说「画一张…图」。</p>
        )}
        {messages.map((m) => (
          <div key={m.mergeKey} className="space-y-1.5">
            <div className="text-[11px] text-zinc-400">{m.role === 'user' ? '你' : '助手'}</div>
            <div className={cn('space-y-1.5', m.role === 'user' && 'rounded-lg bg-zinc-900 px-2.5 py-2 text-zinc-50')}>
              {m.blocks.map((b, i) => {
                if (b.kind === 'text') return <p key={i} className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{b.text}</p>;
                if (b.kind === 'thinking') return <ThinkingBlock key={i} text={b.text} />;
                if (b.kind === 'tool')
                  return (
                    <div key={i} className="rounded-md border border-zinc-200 px-2 py-1.5 text-[11.5px]">
                      <div>
                        <span className="font-mono text-zinc-600">{b.title}</span>
                        {b.status === 'running' && <span className="ml-1 text-amber-600">…</span>}
                        {b.status === 'error' && <span className="ml-1 text-red-600">失败</span>}
                      </div>
                      {b.detail ? (
                        <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={b.detail}>
                          {b.detail}
                        </div>
                      ) : null}
                    </div>
                  );
                if (b.kind === 'images')
                  return (
                    <GeneratedImagesBlock
                      key={i}
                      block={b}
                      {...(resolveImageUrl ? { resolveImageUrl } : {})}
                      {...(onImageOpen ? { onOpen: onImageOpen } : {})}
                      {...(onImageContextMenu ? { onContextMenu: onImageContextMenu } : {})}
                    />
                  );
                if (b.kind === 'attachment')
                  return (
                    <div key={i} className="flex flex-wrap gap-1">
                      {b.files.map((f) => (
                        <span key={f.relPath} className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px]">
                          {f.name} <span className="text-zinc-400">{Math.round(f.size / 1024)} KB</span>
                        </span>
                      ))}
                    </div>
                  );
                if (b.kind === 'selection')
                  return (
                    <div key={i} className="rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-[11.5px] text-zinc-500">
                      <span>已选 {b.source} · {b.chars} 字</span>
                      {b.preview ? (
                        <span className="mt-0.5 block truncate text-zinc-400" title={b.preview}>{b.preview}</span>
                      ) : null}
                    </div>
                  );
                if (b.kind === 'clarification')
                  return (
                    <ClarificationCard
                      key={i}
                      block={b}
                      disabled={status !== 'waiting'}
                      onSubmit={submitClarification}
                    />
                  );
                return <p key={i} className="text-xs text-red-600">{b.text}</p>;
              })}
            </div>
          </div>
        ))}
        {notices.map((n, i) => (
          <p key={`${n}-${i}`} className="text-[11.5px] text-amber-600">{n}</p>
        ))}
      </div>

      <div className="border-t border-zinc-200 p-2.5">
        <div className="rounded-lg border border-zinc-200 p-2">
          {selections.length > 0 && (
            <div className="mb-1.5 space-y-1">
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <span>上下文 {selections.length} 处 · {selectionChars} 字</span>
                <span className="flex-1" />
                <button type="button" onClick={onClearSelections} className="text-zinc-400 hover:text-zinc-700">
                  清空
                </button>
              </div>
              <div className="flex max-h-20 flex-wrap gap-1 overflow-auto">
                {selections.map((selection, index) => (
                  <span
                    key={index}
                    className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-600"
                  >
                    <span className="max-w-[180px] truncate" title={selection.preview}>
                      {selection.preview || '（空白选区）'}
                    </span>
                    <span className="shrink-0 text-zinc-400">{selection.chars} 字</span>
                    <button
                      type="button"
                      aria-label={`移除第 ${index + 1} 处选区`}
                      onClick={() => onRemoveSelection?.(index)}
                      className="shrink-0 px-0.5 text-zinc-400 hover:text-red-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <Textarea
            value={input}
            disabled={awaitingClarification}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={awaitingClarification ? '请先在上方完成澄清选择…' : '继续说… ⌘↵ 发送'}
            className="min-h-[52px] resize-none border-0 p-0 focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center gap-1">
            <span className={cn('text-[11px]', awaitingClarification ? 'text-amber-600' : 'text-zinc-400')}>
              {awaitingClarification ? 'AI 正在等你澄清，请在上方选择' : '右键选区或图片可加入上下文'}
            </span>
            <span className="flex-1" />
            <Button disabled={busy || awaitingClarification} onClick={() => void send(input)}>
              发送
            </Button>
          </div>
        </div>
      </div>
        </>
      )}
    </aside>
  );
}
