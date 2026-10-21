'use client';
import * as React from 'react';
import { Check, Files, MessagesSquare, Plus, Sparkles, Square } from 'lucide-react';
import {
  DEFAULT_CHAT_SESSION_TITLE,
  type ChatEvent,
  type ChatMessage,
  type ChatSession,
  type ChatSessionList,
  type GeneratedImage,
  type Selection,
  type SessionStatus,
} from '@aidocs/contracts';
import { cn } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/input';
import { filterSkills, skillCommand, slashSkillQuery, type ChatSkill } from '../lib/skill-command';
import { ClarificationCard } from './clarification-card';
import { GeneratedImagesBlock } from './generated-images';

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '待命',
  running: '创作中…',
  waiting: '等待输入',
  done: '已完成 · 可收起',
  error: '出错',
};

/** 会话列表里的短状态：空闲/已完成不抢眼，进行中/等待才提示 */
function sessionStatusLabel(status: SessionStatus): string {
  if (status === 'running') return '创作中';
  if (status === 'waiting') return '等待输入';
  if (status === 'error') return '出错';
  if (status === 'done') return '已完成';
  return '空闲';
}

function sessionStatusDot(status: SessionStatus): string {
  if (status === 'running') return 'bg-amber-500 animate-pulse motion-reduce:animate-none';
  if (status === 'waiting') return 'bg-sky-500';
  if (status === 'error') return 'bg-red-500';
  return 'bg-zinc-300';
}

/** 今天的会话只显示时分；更早的显示月-日，避免列表里一排完整时间戳 */
function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

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
  /**
   * 可在输入框里用 `/skill:名称` 显式调用的技能：App 已按「当前类型勾选 + 全局启停」过滤，
   * 列表与发送都只认这一组，避免绕过类型白名单。
   */
  skills?: ChatSkill[];
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
  skills = [],
}: ChatPanelProps) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [status, setStatus] = React.useState<SessionStatus>('idle');
  const [notices, setNotices] = React.useState<string[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // 暂停：POST abort 期间按钮置灰；用 ref 挡住连点，用 token 忽略切会话后才返回的旧请求
  const [stopping, setStopping] = React.useState(false);
  const stoppingRef = React.useRef(false);
  const stopToken = React.useRef(0);
  const sessionIdRef = React.useRef<string | null>(null);
  // 会话切换：清单由服务端给（同一文档可新建/切换），events/messages 都带 session 参数
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = React.useState(false);
  const [sessionBusy, setSessionBusy] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const headerRef = React.useRef<HTMLElement>(null);
  const lastStatusRef = React.useRef<SessionStatus | null>(null);
  const selectionChars = selections.reduce((sum, selection) => sum + selection.chars, 0);
  const awaitingClarification = status === 'waiting';
  // 「暂停」只在模型还在干活时出现：running 是生成中，waiting 是等澄清
  const canPause = Boolean(sessionId) && (status === 'running' || status === 'waiting');
  // 技能指令：输入 "/" 唤起浮层，继续输入即过滤；选中后把 /skill:名称 写回输入框
  const [skillIndex, setSkillIndex] = React.useState(0);
  const [skillDismissed, setSkillDismissed] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const skillMenuRef = React.useRef<HTMLDivElement>(null);
  const skillListId = React.useId();
  const skillQuery = slashSkillQuery(input);
  const skillMatches = React.useMemo(
    () => (skillQuery === null ? [] : filterSkills(skills, skillQuery)),
    [skillQuery, skills],
  );
  // 澄清中输入框本来就禁用，不再叠一层技能浮层
  const skillMenuOpen = skillQuery !== null && !skillDismissed && !awaitingClarification;
  const activeSkillIndex = skillMatches.length ? Math.min(skillIndex, skillMatches.length - 1) : 0;
  const activeSkill = skillMatches[activeSkillIndex];

  const chatBase = `/api/docs/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  const sessionsUrl = `${chatBase}/sessions`;
  const eventsUrl = sessionId ? `${chatBase}/events?session=${encodeURIComponent(sessionId)}` : null;

  // 打开文档 / 换文档时先取会话清单，拿到 activeId 再连事件流；失败时保留空态并提示
  React.useEffect(() => {
    let cancelled = false;
    setSessionId(null);
    setSessions([]);
    setSessionError(null);
    setSessionMenuOpen(false);
    setMessages([]);
    setNotices([]);
    setStatus('idle');
    setInput('');
    lastStatusRef.current = null;
    void (async () => {
      try {
        const data = await requestJson<ChatSessionList>(sessionsUrl);
        if (cancelled) return;
        setSessions(data.sessions);
        setSessionId(data.activeId || data.sessions[0]?.id || null);
      } catch (error) {
        if (!cancelled) setSessionError(`会话加载失败：${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionsUrl]);

  React.useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  React.useEffect(() => {
    if (!eventsUrl) return;
    const es = new EventSource(eventsUrl);
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
  }, [eventsUrl, onDocUpdated]);

  // 会话菜单是按钮旁的轻量浮层：点外面或 Esc 关闭
  React.useEffect(() => {
    if (!sessionMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setSessionMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sessionMenuOpen]);

  // 菜单打开时轻量轮询：后台会话的「创作中/等待输入」状态也能及时更新
  React.useEffect(() => {
    if (!sessionMenuOpen) return;
    const timer = setInterval(() => {
      void refreshSessions();
    }, 5_000);
    return () => clearInterval(timer);
  }, [sessionMenuOpen, sessionsUrl]);

  // 进入文档文件视图 / 收起时关闭会话浮层，避免展开后突然冒出来
  React.useEffect(() => {
    if (filesOpen || collapsed) setSessionMenuOpen(false);
  }, [filesOpen, collapsed]);

  // 技能浮层打开时点外面关闭；点击列表项本身在 mousedown 里已处理，不会走到这里
  React.useEffect(() => {
    if (!skillMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setSkillDismissed(true);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [skillMenuOpen]);

  // 过滤词变化后从第一项重新选；Esc 关闭后只要继续输入就会自动重新打开
  React.useEffect(() => {
    setSkillIndex(0);
  }, [skillQuery]);

  React.useEffect(() => {
    setSkillDismissed(false);
  }, [input]);

  // 键盘移动选中项时把它滚进视口：列表可能超出一屏
  React.useEffect(() => {
    if (!skillMenuOpen) return;
    skillMenuRef.current?.querySelector<HTMLElement>('[data-skill-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeSkillIndex, skillMenuOpen]);

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

  /** 只刷新清单，不动当前会话（用于打开菜单 / 发送后同步标题） */
  async function refreshSessions(): Promise<void> {
    try {
      const data = await requestJson<ChatSessionList>(sessionsUrl);
      setSessions(data.sessions);
      // 首次加载失败后菜单轮询成功时，也顺手把事件流接上；已有会话则不动
      setSessionId((current) => current ?? (data.activeId || data.sessions[0]?.id || null));
      setSessionError(null);
    } catch (error) {
      setSessionError(`会话加载失败：${(error as Error).message}`);
    }
  }

  /** 首次加载失败时重试；成功后连上该会话的事件流 */
  async function retrySessions(): Promise<void> {
    setSessionError(null);
    try {
      const data = await requestJson<ChatSessionList>(sessionsUrl);
      setSessions(data.sessions);
      setSessionId(data.activeId || data.sessions[0]?.id || null);
    } catch (error) {
      setSessionError(`会话加载失败：${(error as Error).message}`);
    }
  }

  function resetConversation(): void {
    // 切走会话后，上一段暂停请求的结果与本视图无关
    stopToken.current += 1;
    stoppingRef.current = false;
    setStopping(false);
    setMessages([]);
    setNotices([]);
    setStatus('idle');
    setInput('');
    lastStatusRef.current = null;
  }

  /** 切换会话：先本地切过去（事件流按 session 重连），再记住服务端 activeId */
  async function selectSession(id: string): Promise<void> {
    setSessionMenuOpen(false);
    if (filesOpen) onToggleFiles?.();
    if (id === sessionId) return;
    resetConversation();
    setSessionId(id);
    try {
      const data = await requestJson<ChatSessionList>(sessionsUrl, {
        method: 'PATCH',
        body: JSON.stringify({ activeId: id }),
      });
      setSessions(data.sessions);
      setSessionError(null);
    } catch (error) {
      // 服务端没记住也不影响本页继续用带 session 参数的接口
      setNotices((prev) => [...prev.slice(-4), `未能记住当前会话：${(error as Error).message}`]);
    }
  }

  /** 新建会话：等服务端建好再切，避免失败时把原会话清空 */
  async function createSession(): Promise<void> {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionMenuOpen(false);
    if (filesOpen) onToggleFiles?.();
    try {
      const data = await requestJson<ChatSessionList>(sessionsUrl, { method: 'POST' });
      setSessions(data.sessions);
      setSessionError(null);
      resetConversation();
      setSessionId(data.activeId);
    } catch (error) {
      setNotices((prev) => [...prev.slice(-4), `新建会话失败：${(error as Error).message}`]);
    } finally {
      setSessionBusy(false);
    }
  }

  /** 选中技能：写回 /skill:名称 并把光标放到末尾，用户直接接着写需求 */
  function insertSkill(skill: ChatSkill): void {
    const command = skillCommand(skill);
    setInput(command);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(command.length, command.length);
    });
  }

  async function send(text: string) {
    const value = text.trim();
    if (!value || busy || awaitingClarification || !sessionId) return;
    setBusy(true);
    try {
      const response = await fetch(`${chatBase}/messages?session=${encodeURIComponent(sessionId)}`, {
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
      // 首条消息会把「新会话」改成消息摘要，顺手同步列表标题
      void refreshSessions();
    } catch (error) {
      setNotices((prev) => [...prev.slice(-4), `发送失败：${(error as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  /** 暂停本轮：中断模型与工具，已写入文件的内容保留；会话仍可继续追问 */
  async function stop(): Promise<void> {
    const target = sessionId;
    if (!target || stoppingRef.current) return;
    const token = stopToken.current + 1;
    stopToken.current = token;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await requestJson<{ ok: true }>(`${chatBase}/abort?session=${encodeURIComponent(target)}`, {
        method: 'POST',
      });
      if (stopToken.current === token) {
        setNotices((prev) => [...prev.slice(-4), '已暂停本轮创作']);
      }
    } catch (error) {
      if (stopToken.current === token) {
        setNotices((prev) => [...prev.slice(-4), `暂停失败：${(error as Error).message}`]);
      }
    } finally {
      if (stopToken.current === token) {
        stoppingRef.current = false;
        setStopping(false);
      }
    }
  }

  /** 澄清卡提交：POST 后等待 SSE 把卡片更新为「已答复」，同一轮创作自动继续 */
  async function submitClarification(groupId: string, answers: Record<string, string>): Promise<void> {
    if (!sessionId) return;
    const response = await fetch(`${chatBase}/clarifications?session=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId, answers }),
    });
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
      <header ref={headerRef} className="relative flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setSessionMenuOpen((open) => !open);
            if (!sessionMenuOpen) void refreshSessions();
          }}
          title="会话列表"
          aria-label="会话列表"
          aria-haspopup="dialog"
          aria-expanded={sessionMenuOpen}
          className={cn(sessionMenuOpen && 'bg-zinc-100 text-zinc-900')}
        >
          <MessagesSquare className="h-4 w-4" aria-hidden="true" />
        </Button>
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

        {/* 会话浮层：新建与切换都在这里；切换后事件流按新 session 重连 */}
        {sessionMenuOpen ? (
          <div
            role="dialog"
            aria-label="会话列表"
            className="absolute right-2 top-full z-20 mt-1 w-[min(320px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
          >
            <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5 py-1.5">
              <span className="text-[11px] font-medium tracking-wide text-zinc-500">会话</span>
              <Badge className="px-1.5 py-0 text-[10.5px]">{sessions.length}</Badge>
              <span className="flex-1" />
              <span className="text-[10.5px] text-zinc-400">上下文互相独立</span>
            </div>
            <div className="max-h-80 overflow-auto py-1" role="menu" aria-label="会话">
              {sessions.length === 0 ? (
                <p className="px-2.5 py-3 text-[11.5px] text-zinc-400">{sessionError ?? '正在加载会话…'}</p>
              ) : (
                sessions.map((session) => {
                  const active = session.id === sessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => void selectSession(session.id)}
                      className={cn(
                        'flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none',
                        active && 'bg-zinc-100/80',
                      )}
                    >
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                        {active ? (
                          <Check className="h-3.5 w-3.5 text-zinc-700" aria-hidden="true" />
                        ) : (
                          <span
                            className={cn('h-1.5 w-1.5 rounded-full', sessionStatusDot(session.status))}
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-[12.5px]', active ? 'font-medium text-zinc-900' : 'text-zinc-700')}>
                          {session.title || DEFAULT_CHAT_SESSION_TITLE}
                        </span>
                        <span className="mt-0.5 block text-[10.5px] text-zinc-400">
                          {sessionStatusLabel(session.status)} · {formatSessionTime(session.updatedAt)}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {sessionError && sessions.length > 0 ? (
              <p className="border-t border-zinc-100 px-2.5 py-1.5 text-[11px] text-amber-600">{sessionError}</p>
            ) : null}
            <div className="border-t border-zinc-100 p-1.5">
              <Button
                variant="ghost"
                className="w-full justify-start text-[12.5px]"
                onClick={() => void createSession()}
                disabled={sessionBusy}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {sessionBusy ? '新建中…' : '新建会话'}
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      {filesOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">{filesPanel}</div>
      ) : (
        <>
      <div ref={listRef} className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {sessions.length === 0 && sessionError ? (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11.5px] text-amber-700">
            <span className="min-w-0 flex-1">{sessionError}</span>
            <button type="button" onClick={() => void retrySessions()} className="shrink-0 underline underline-offset-2">
              重试
            </button>
          </div>
        ) : null}
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
        <div ref={composerRef} className="relative rounded-lg border border-zinc-200 p-2">
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
          {skillMenuOpen ? (
            <div
              ref={skillMenuRef}
              className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-30 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
            >
              <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5 py-1.5">
                <Sparkles className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                <span className="text-[11px] font-medium tracking-wide text-zinc-500">技能</span>
                <Badge className="px-1.5 py-0 text-[10.5px]">{skillMatches.length}</Badge>
                <span className="flex-1" />
                <span className="text-[10.5px] text-zinc-400">输入筛选</span>
              </div>
              <ul
                id={skillListId}
                role="listbox"
                aria-label="技能"
                className="max-h-[min(280px,50vh)] overflow-auto py-1"
              >
                {skillMatches.length === 0 ? (
                  <li className="px-2.5 py-3 text-[11.5px] text-zinc-400">
                    {skills.length === 0
                      ? '当前类型还没有可用技能，可在「编辑类型 → 技能」勾选，或到「设置 → Skills」启用。'
                      : '没有匹配的技能，换个关键词试试。'}
                  </li>
                ) : (
                  skillMatches.map((skill, index) => {
                    const active = index === activeSkillIndex;
                    return (
                      <li
                        key={`${skill.origin}:${skill.name}`}
                        id={`${skillListId}-option-${index}`}
                        role="option"
                        aria-selected={active}
                        {...(active ? { 'data-skill-active': 'true' } : {})}
                        onMouseDown={(event) => {
                          // 保持输入框焦点：点完可以直接接着写需求
                          event.preventDefault();
                          insertSkill(skill);
                        }}
                        onMouseEnter={() => setSkillIndex(index)}
                        className={cn(
                          'flex cursor-pointer items-start gap-2 px-2.5 py-1.5',
                          active && 'bg-zinc-100',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12px] text-zinc-800">{skill.name}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-zinc-400" title={skill.description}>
                            {skill.description || '（无描述）'}
                          </span>
                        </span>
                        <Badge className="mt-0.5 shrink-0 px-1.5 py-0 text-[10px]">
                          {skill.origin === 'personal' ? '个人' : '项目'}
                        </Badge>
                      </li>
                    );
                  })
                )}
              </ul>
              <div className="flex items-center gap-2 border-t border-zinc-100 px-2.5 py-1.5 text-[10.5px] text-zinc-400">
                <span>↑↓ 选择 · ↵ 插入 · Esc 关闭</span>
                <span className="flex-1" />
                <span className="truncate">插入 /skill:名称</span>
              </div>
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={input}
            disabled={awaitingClarification}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组合中的回车/方向键属于候选词，不能拿来选技能
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send(input);
                return;
              }
              if (!skillMenuOpen) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (skillMatches.length === 0) return;
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                const current = Math.min(skillIndex, skillMatches.length - 1);
                setSkillIndex((current + delta + skillMatches.length) % skillMatches.length);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setSkillDismissed(true);
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && activeSkill) {
                e.preventDefault();
                insertSkill(activeSkill);
              }
            }}
            placeholder={awaitingClarification ? '请先在上方完成澄清选择…' : '继续说… ⌘↵ 发送'}
            aria-autocomplete="list"
            aria-expanded={skillMenuOpen}
            aria-controls={skillMenuOpen ? skillListId : undefined}
            aria-activedescendant={skillMenuOpen && activeSkill ? `${skillListId}-option-${activeSkillIndex}` : undefined}
            className="min-h-[52px] resize-none border-0 p-0 focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center gap-1">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11px]',
                awaitingClarification || status === 'running' ? 'text-amber-600' : 'text-zinc-400',
              )}
            >
              {awaitingClarification
                ? 'AI 正在等你澄清，请在上方选择'
                : status === 'running'
                  ? 'AI 正在创作，可随时暂停'
                  : '输入 / 选技能 · 右键选区或图片加入上下文'}
            </span>
            {canPause ? (
              <Button
                variant="outline"
                className="shrink-0"
                disabled={stopping}
                onClick={() => void stop()}
                title="中断本轮创作，已写入的内容保留"
                aria-label="暂停本轮创作"
              >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                {stopping ? '暂停中…' : '暂停'}
              </Button>
            ) : null}
            <Button
              className="shrink-0"
              disabled={busy || awaitingClarification || !sessionId}
              onClick={() => void send(input)}
            >
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
