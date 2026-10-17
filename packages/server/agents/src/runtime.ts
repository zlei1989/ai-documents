import { join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Block, ChatEvent, ChatEventDraft, ChatMessage, GeneratedImage, McpServer, SessionStatus, ThinkingLevel, ToolName, TypeManifest } from '@aidocs/contracts';
import { appendEvent, normalizeAssetPath, readEvents, readEventsAfter } from '@aidocs/core';
import { buildPiSession, type PiProviderInput, materializeResources } from './assembly';
import { CLARIFICATION_TOOL, ClarificationHub } from './clarify';
import { buildTypePrompt } from './prompt';
import type { ResearchToolOptions } from './research';
import { SEEDREAM_TOOL_NAME, type SeedreamToolOptions } from './seedream';
import {
  dropClarificationHub,
  dropRuntime,
  dropSession,
  getClarificationHub,
  getRuntime,
  getSession,
  putClarificationHub,
  putRuntime,
  putSession,
} from './registry';

export interface RuntimeInput {
  artifactDir: string;
  typeDir: string;
  manifest: TypeManifest;
  mcp?: McpServer[];
  /** 资料查询配置；默认注入，配置不可用时不注册 research_* 工具 */
  research?: Omit<ResearchToolOptions, 'artifactDir'>;
  /** 资料查询配置不可用时的原因（降级为 warn notice，不打断创作） */
  researchDisabledReason?: string;
  /** 生图配置；启用且配置完整时才注册 seedream_image_generation */
  seedream?: Omit<SeedreamToolOptions, 'artifactDir'>;
  /** 生图已启用但配置不可用时的原因（降级为 warn notice） */
  seedreamDisabledReason?: string;
  promptText?: string;
  /** 思考强度：会话创建时快照；off / 不给 = 不向供应商发推理参数 */
  thinkingLevel?: ThinkingLevel;
  provider: PiProviderInput;
  agentDir: string;
  /** 若要重启会话（类型改动 / 进程重启），传入已有会话文件 */
  sessionFile?: string;
  /** 一轮结束（agent_settled）后的回调，用于自动提交 */
  onSettled?: () => void;
}

type Listener = (event: ChatEvent) => void;

/** 一个 Artifact 的聊天运行时：装配 pi 会话、投影事件、写 ui.jsonl */
export class ChatRuntime {
  private constructor(
    readonly artifactDir: string,
    readonly session: AgentSession,
    private readonly uiLog: string,
    private readonly listeners: Set<Listener>,
    private readonly messages: Map<string, ChatMessage>,
    private status: SessionStatus,
    private readonly round: { value: number },
    private readonly clarify: ClarificationHub,
    private readonly onSettled?: () => void,
  ) {}

  /** 同一轮里模型可能「文本 → 工具 → 文本」；按助手消息切段，最后一段标记为 final */
  private textSegment = 0;
  private currentTextKey: string | null = null;
  private thinkingSegment = 0;
  private currentThinkingKey: string | null = null;

  static async create(input: RuntimeInput): Promise<ChatRuntime> {
    const sessionsDir = join(input.artifactDir, 'sessions');
    const uiLog = join(sessionsDir, 'ui.jsonl');
    const cached = getRuntime<ChatRuntime>(input.artifactDir);
    if (cached) return cached;

    // HMR 后 session 还在、runtime 被重建时，复用同一个 hub，工具闭包里才能拿到新 sink
    const clarify = getClarificationHub(input.artifactDir) ?? new ClarificationHub();
    putClarificationHub(input.artifactDir, clarify);

    const existing = getSession(input.artifactDir);
    if (existing) {
      // 进程内已有会话但没有运行时（如 HMR 后）：重建运行时并重新绑定事件
      const rt = new ChatRuntime(input.artifactDir, existing, uiLog, new Set(), new Map(), 'idle', { value: initialRound(uiLog) }, clarify, input.onSettled);
      clarify.bind(rt);
      rt.bind();
      putRuntime(input.artifactDir, rt);
      return rt;
    }

    const resources = materializeResources(input.artifactDir, input.typeDir, input.manifest.resources.map((r) => r.path));
    const handle = await buildPiSession({
      artifactDir: input.artifactDir,
      sessionsDir,
      agentDir: input.agentDir,
      manifest: input.manifest,
      resources,
      ...(input.mcp ? { mcp: input.mcp } : {}),
      ...(input.research ? { research: input.research } : {}),
      ...(input.seedream ? { seedream: input.seedream } : {}),
      ...(input.promptText ? { promptText: input.promptText } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      provider: input.provider,
      clarify,
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    });
    putSession(input.artifactDir, handle.session);

    const runtime = new ChatRuntime(input.artifactDir, handle.session, uiLog, new Set(), new Map(), 'idle', { value: initialRound(uiLog) }, clarify, input.onSettled);
    clarify.bind(runtime);
    runtime.bind();
    putRuntime(input.artifactDir, runtime);
    if (input.researchDisabledReason) {
      runtime.publish({
        type: 'notice',
        level: 'warn',
        text: `资料查询未生效：${input.researchDisabledReason}（设置 → 资料查询）`,
      });
    }
    if (input.seedreamDisabledReason) {
      runtime.publish({
        type: 'notice',
        level: 'warn',
        text: `生图工具未生效：${input.seedreamDisabledReason}（设置 → 模型供应商 → 火山引擎）`,
      });
    }
    return runtime;
  }

  private bind(): void {
    this.session.subscribe((event: unknown) => {
      const e = event as Record<string, any>;
      switch (e.type) {
        case 'agent_start':
          this.emitStatus('running');
          break;
        case 'message_update': {
          const deltaEvent = e.assistantMessageEvent;
          if (deltaEvent?.type === 'text_delta') {
            if (!this.currentTextKey) {
              this.textSegment += 1;
              this.currentTextKey = `a-${this.round.value}-${this.textSegment}`;
              this.messages.set(this.currentTextKey, {
                id: this.currentTextKey,
                mergeKey: this.currentTextKey,
                role: 'assistant',
                blocks: [{ kind: 'text', text: '', streaming: true }],
                round: this.round.value,
              });
            }
            const key = this.currentTextKey;
            const msg = key ? this.messages.get(key) : undefined;
            const block = msg?.blocks[0];
            if (msg && block && block.kind === 'text') {
              block.text += String(deltaEvent.delta ?? '');
              this.emitMessage(msg);
            }
          } else if (deltaEvent?.type === 'thinking_delta') {
            if (!this.currentThinkingKey) {
              this.thinkingSegment += 1;
              this.currentThinkingKey = `th-${this.round.value}-${this.thinkingSegment}`;
              this.messages.set(this.currentThinkingKey, {
                id: this.currentThinkingKey,
                mergeKey: this.currentThinkingKey,
                role: 'assistant',
                blocks: [{ kind: 'thinking', text: '' }],
                round: this.round.value,
              });
            }
            const key = this.currentThinkingKey;
            const msg = key ? this.messages.get(key) : undefined;
            const block = msg?.blocks[0];
            if (msg && block && block.kind === 'thinking') {
              block.text += String(deltaEvent.delta ?? '');
              this.emitMessage(msg);
            }
          }
          break;
        }
        case 'message_end': {
          if (this.currentTextKey) {
            const msg = this.messages.get(this.currentTextKey);
            if (msg) {
              for (const b of msg.blocks) if (b.kind === 'text') b.streaming = false;
              this.emitMessage(msg);
            }
            this.currentTextKey = null;
          }
          if (this.currentThinkingKey) {
            const msg = this.messages.get(this.currentThinkingKey);
            if (msg) this.emitMessage(msg);
            this.currentThinkingKey = null;
          }
          break;
        }
        case 'tool_execution_start': {
          // 澄清提问由 hub 自己发「问题卡」消息，不重复渲染成工具卡
          if (e.toolName === CLARIFICATION_TOOL) break;
          const msg: ChatMessage = {
            id: `t-${e.toolCallId}`,
            mergeKey: `t-${e.toolCallId}`,
            role: 'assistant',
            blocks: [
              {
                kind: 'tool',
                tool: normalizeTool(e.toolName),
                title: toolTitle(e.toolName, e.args),
                status: 'running',
              } satisfies Block,
            ],
            round: this.round.value,
          };
          this.messages.set(msg.id, msg);
          this.emitMessage(msg);
          break;
        }
        case 'tool_execution_update': {
          if (e.toolName === CLARIFICATION_TOOL) break;
          const msg = this.messages.get(`t-${e.toolCallId}`);
          if (!msg) break;
          const detail = summarizeResult(e.partialResult);
          const block = msg.blocks[0];
          if (block && block.kind === 'tool' && detail) {
            block.detail = detail;
            this.emitMessage(msg);
          }
          break;
        }
        case 'tool_execution_end': {
          if (e.toolName === CLARIFICATION_TOOL) break;
          const key = `t-${e.toolCallId}`;
          const msg = this.messages.get(key);
          if (msg) {
            const block = msg.blocks[0];
            if (block && block.kind === 'tool') {
              block.status = e.isError ? 'error' : 'ok';
              block.detail = summarizeResult(e.result);
            }
            // 生图结果：把 details.images 投影成消息流里的图片格子（同一条工具消息）
            if (e.toolName === SEEDREAM_TOOL_NAME) {
              const images = projectToolImages(e.result);
              if (images.length > 0 && !msg.blocks.some((item) => item.kind === 'images')) {
                msg.blocks.push({ kind: 'images', images });
              }
            }
            this.emitMessage(msg);
          }
          break;
        }
        case 'agent_settled': {
          const final = this.latestTextMessage();
          if (final) {
            final.final = true;
            for (const b of final.blocks) if (b.kind === 'text') b.streaming = false;
            this.emitMessage(final);
          }
          this.currentTextKey = null;
          this.currentThinkingKey = null;
          this.emitStatus('done');
          this.onSettled?.();
          break;
        }
        case 'agent_end':
          if (e.willRetry) this.emitStatus('running');
          break;
        default:
          break;
      }
    });
  }

  /** 本轮最后一条带文本的 assistant 消息；settled 时打上 final，历史回放只留它 */
  private latestTextMessage(): ChatMessage | undefined {
    let found: ChatMessage | undefined;
    for (const msg of this.messages.values()) {
      if (msg.round !== this.round.value || msg.role !== 'assistant') continue;
      if (!msg.blocks.some((b) => b.kind === 'text' && b.text.trim())) continue;
      found = msg;
    }
    return found;
  }

  publish(event: ChatEventDraft): void {
    const full = appendEvent(this.uiLog, event);
    for (const l of this.listeners) l(full);
  }

  emitStatus(status: SessionStatus): void {
    this.status = status;
    this.publish({ type: 'status', status });
  }

  currentRound(): number {
    return this.round.value;
  }

  private emitMessage(message: ChatMessage): void {
    this.publish({ type: 'message', message: structuredClone(message) });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(afterSeq: number): ChatEvent[] {
    return readEventsAfter(this.uiLog, afterSeq);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  /** 把 UI 上的选择送给正在等待的澄清工具；false = 已失效/已回答 */
  answerClarification(groupId: string, answers: Record<string, string>): boolean {
    return this.clarify.answer(groupId, answers);
  }

  get pendingClarifications(): number {
    return this.clarify.pendingCount;
  }

  async send(text: string, opts: { attachments?: ChatMessage['blocks']; mode?: 'steer' | 'followUp'; selections?: { source: string; chars: number; preview: string }[]; prompt: string }): Promise<'sent' | 'queued'> {
    if (this.status === 'waiting') {
      throw new Error('请先回答上方的澄清问题，再继续发送。');
    }
    if (this.status !== 'running') {
      this.textSegment = 0;
      this.currentTextKey = null;
      this.thinkingSegment = 0;
      this.currentThinkingKey = null;
    }
    this.round.value += 1;
    const userBlocks: Block[] = [{ kind: 'text', text }];
    if (opts.attachments?.length) for (const b of opts.attachments) userBlocks.push(b);
    if (opts.selections?.length) {
      for (const s of opts.selections) userBlocks.push({ kind: 'selection', source: s.source, chars: s.chars, preview: s.preview });
    }
    const userMsg: ChatMessage = {
      id: `u-${this.round.value}`,
      mergeKey: `u-${this.round.value}`,
      role: 'user',
      blocks: userBlocks,
      round: this.round.value,
    };
    this.messages.set(userMsg.id, userMsg);
    this.emitMessage(userMsg);

    const prompt = opts.prompt;
    if (this.status === 'running') {
      const result = opts.mode === 'followUp' ? await this.session.followUp(prompt) : await this.session.steer(prompt);
      return result === 'queued' ? 'queued' : 'sent';
    }
    void this.session.prompt(prompt).catch((error: unknown) => {
      this.publish({ type: 'notice', level: 'error', text: `调用失败：${String((error as Error)?.message ?? error)}` });
      this.emitStatus('error');
    });
    return 'sent';
  }

  async abort(): Promise<void> {
    // 先 abort：工具的 AbortSignal 会让等待中的澄清立即结算，再兜底 cancelAll
    await this.session.abort();
    this.clarify.cancelAll('用户中断');
    this.emitStatus('idle');
  }

  dispose(): void {
    this.clarify.cancelAll('会话已关闭');
    dropClarificationHub(this.artifactDir);
    dropRuntime(this.artifactDir);
    dropSession(this.artifactDir);
  }
}

function normalizeTool(name: string): ToolName {
  if (name.startsWith('research_')) return 'research';
  if (name.startsWith('archify_')) return 'archify';
  if (name === SEEDREAM_TOOL_NAME) return 'image';
  const map: Partial<Record<string, ToolName>> = {
    read: 'read',
    write: 'write',
    edit: 'edit',
    ls: 'ls',
    grep: 'grep',
  };
  return map[name] ?? 'mcp';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function toolTitle(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === 'archify_guidelines') {
    const type = typeof a.type === 'string' ? a.type : '';
    return type ? `Archify 规范 · ${type}` : 'Archify 规范';
  }
  if (name === 'archify_save') {
    const type = typeof a.type === 'string' ? a.type : '';
    return type ? `Archify 图示 · ${type}` : 'Archify 图示';
  }
  if (name === 'research_search') {
    const query = typeof a.query === 'string' ? a.query.trim() : '';
    return query ? `资料搜索 · ${query}` : '资料搜索';
  }
  if (name === 'research_fetch') {
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    return url ? `资料抓取 · ${hostOf(url)}` : '资料抓取';
  }
  if (name === 'research_save') {
    const title = typeof a.title === 'string' ? a.title.trim() : '';
    return title ? `存资料 · ${title}` : '存资料';
  }
  if (name === SEEDREAM_TOOL_NAME) {
    const title = typeof a.title === 'string' ? a.title.trim() : '';
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    const summary = title || prompt.slice(0, 18);
    return summary ? `生图 · ${summary}` : '生图';
  }
  const path = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : '';
  return path ? `${name} · ${path}` : name;
}

function summarizeResult(result: unknown): string | undefined {
  if (!result) return undefined;
  const text = resultText(result);
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * 从工具结果 details 里提取可投影到消息流的生图结果。
 * 只接受 assets/ 下的安全路径；去重、上限 32；坏项静默丢弃。
 */
export function projectToolImages(result: unknown): GeneratedImage[] {
  if (!result || typeof result !== 'object') return [];
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return [];
  const raw = (details as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const images: GeneratedImage[] = [];
  for (const item of raw) {
    if (images.length >= 32) break;
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || !value.path.trim()) continue;
    let path: string;
    try {
      path = normalizeAssetPath(value.path);
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const alt = typeof value.alt === 'string' ? value.alt : '';
    const size = typeof value.size === 'string' && value.size.trim() ? value.size : undefined;
    images.push({ path, alt, ...(size ? { size } : {}) });
  }
  return images;
}

/** pi 的工具结果形如 `{ content: [{ type: 'text', text }] }`；失败结果也要能取到文案 */
function resultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((part): part is { type: string; text: string } => {
          const item = part as { type?: unknown; text?: unknown };
          return item?.type === 'text' && typeof item.text === 'string';
        })
        .map((part) => part.text);
      if (parts.length > 0) return parts.join('\n');
    }
    return JSON.stringify(result);
  }
  return String(result);
}

/** 续接 ui.jsonl 时的起始轮次：避免重建会话后 `a-1` 之类的 mergeKey 与历史碰撞 */
export function initialRound(uiLog: string): number {
  let max = 0;
  try {
    for (const event of readEvents(uiLog)) {
      if (event.type !== 'message') continue;
      const round = event.message.round;
      if (typeof round === 'number' && round > max) max = round;
    }
  } catch {
    /* 读不到就当第一轮 */
  }
  return max;
}

/** 组装发给模型的提示词：附件与选区变成明确文本块 */
export function composePrompt(input: {
  text: string;
  attachments?: { name: string; size: number; relPath: string }[];
  selections?: { source: string; chars: number; preview: string; text: string }[];
  /** 编辑器手动保存过、需要提醒模型先 read 的图示 */
  manualDiagramEdits?: { path: string; at: string }[];
}): string {
  const parts: string[] = [];
  if (input.manualDiagramEdits?.length) {
    parts.push('【图示手动编辑提醒】');
    parts.push('下面这些 SVG 图示在本会话之外被修改过，磁盘上的版本才是最新基线。修改前请先用 read 读取，不要沿用历史里的旧 SVG：');
    for (const note of input.manualDiagramEdits) parts.push(`- ${note.path}（${note.at}）`);
    parts.push('');
  }
  if (input.selections?.length) {
    const total = input.selections.length;
    input.selections.forEach((selection, index) => {
      parts.push(`【用户选中的文档内容 · 第 ${index + 1}/${total} 处】source=${selection.source} chars=${selection.chars}`);
      parts.push(selection.text);
      parts.push('');
    });
  }
  if (input.attachments?.length) {
    parts.push('【附件】');
    for (const f of input.attachments) parts.push(`- ${f.relPath}（${f.name}, ${f.size} 字节）`);
    parts.push('');
  }
  parts.push(input.text);
  return parts.join('\n');
}

export { buildTypePrompt };
