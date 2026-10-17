import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type {
  ChatEventDraft,
  ClarificationBlock,
  ClarificationQuestion,
  SessionStatus,
} from '@aidocs/contracts';

export const CLARIFICATION_TOOL = 'request_clarification';

export interface ClarificationRequest {
  intro?: string;
  questions: {
    text: string;
    options: { label: string; value?: string; description?: string }[];
    allowOther?: boolean;
  }[];
}

export type ClarificationOutcome =
  | { status: 'answered'; answers: Record<string, string>; questions: ClarificationQuestion[] }
  | { status: 'expired'; reason: string };

/** 运行时只需要这三个能力：发事件、改状态、知道当前轮次 */
export interface ClarificationSink {
  publish(event: ChatEventDraft): void;
  emitStatus(status: SessionStatus): void;
  currentRound(): number;
}

interface PendingGroup {
  block: ClarificationBlock;
  resolve: (outcome: ClarificationOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ClarificationHubOptions {
  /** 无人应答时的兜底时长；默认 10 分钟。0 = 不超时 */
  timeoutMs?: number;
}

/**
 * 澄清提问的等待区。
 *
 * 自定义工具 `request_clarification` 调用 `request()` 后阻塞；UI 通过
 * `POST /clarifications` 把选择送进 `answer()`，工具拿到回答后继续同一轮创作。
 * 等待期间的 question/answered/expired 三次快照都写进 ui.jsonl，刷新可回放。
 */
export class ClarificationHub {
  private sink: ClarificationSink | null = null;
  private readonly pending = new Map<string, PendingGroup>();
  private readonly timeoutMs: number;

  constructor(options: ClarificationHubOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  bind(sink: ClarificationSink): void {
    this.sink = sink;
  }

  async request(input: ClarificationRequest, signal?: AbortSignal): Promise<ClarificationOutcome> {
    // 注入预览/无 UI 的装配：不阻塞，直接让模型按默认写。
    const sink = this.sink;
    if (!sink) return { status: 'expired', reason: '澄清界面未就绪' };
    if (signal?.aborted) return { status: 'expired', reason: '用户中断' };

    const groupId = randomUUID();
    const questions: ClarificationQuestion[] = input.questions.map((question, index) => ({
      id: `q${index + 1}-${groupId.slice(0, 8)}`,
      text: question.text,
      allowOther: question.allowOther ?? true,
      options: question.options.map((option) => ({
        label: option.label,
        value: option.value ?? option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    }));
    if (questions.length === 0) return { status: 'expired', reason: '没有有效问题' };

    const block: ClarificationBlock = {
      kind: 'clarification',
      groupId,
      ...(input.intro?.trim() ? { intro: input.intro.trim() } : {}),
      questions,
      status: 'pending',
    };

    return new Promise<ClarificationOutcome>((resolve) => {
      const finish = (outcome: ClarificationOutcome): void => {
        const current = this.pending.get(groupId);
        if (!current) return;
        this.pending.delete(groupId);
        this.release(current);
        this.emit({
          ...current.block,
          status: outcome.status === 'answered' ? 'answered' : 'expired',
          ...(outcome.status === 'answered' ? { answers: outcome.answers } : {}),
        });
        this.sink?.emitStatus('running');
        current.resolve(outcome);
      };

      const onAbort = () => finish({ status: 'expired', reason: '用户中断' });
      const entry: PendingGroup = { block, resolve };
      if (signal) {
        entry.signal = signal;
        entry.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(
          () => finish({ status: 'expired', reason: `等待超过 ${Math.round(this.timeoutMs / 1000)} 秒` }),
          this.timeoutMs,
        );
      }
      this.pending.set(groupId, entry);
      this.emit(block);
      sink.emitStatus('waiting');
    });
  }

  /** 返回 false = 这组问题已失效/已回答/线程重启后丢了等待态 */
  answer(groupId: string, answers: Record<string, string>): boolean {
    const current = this.pending.get(groupId);
    if (!current) return false;
    const normalized: Record<string, string> = {};
    for (const question of current.block.questions) {
      const value = (answers[question.id] ?? '').trim();
      normalized[question.id] = value ? value.slice(0, 500) : '未指定（按最合理判断）';
    }
    this.pending.delete(groupId);
    this.release(current);
    this.emit({ ...current.block, status: 'answered', answers: normalized });
    this.sink?.emitStatus('running');
    current.resolve({ status: 'answered', answers: normalized, questions: current.block.questions });
    return true;
  }

  /** 中断/关会话时把所有等待中的问题标成已失效，避免 UI 一直转圈 */
  cancelAll(reason: string): void {
    for (const [groupId, current] of [...this.pending]) {
      this.pending.delete(groupId);
      this.release(current);
      this.emit({ ...current.block, status: 'expired' });
      current.resolve({ status: 'expired', reason });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private release(current: PendingGroup): void {
    if (current.timer) clearTimeout(current.timer);
    if (current.signal && current.onAbort) current.signal.removeEventListener('abort', current.onAbort);
  }

  private emit(block: ClarificationBlock): void {
    if (!this.sink) return;
    this.sink.publish({
      type: 'message',
      message: {
        id: `cl-${block.groupId}`,
        mergeKey: `cl-${block.groupId}`,
        role: 'assistant',
        blocks: [block],
        round: this.sink.currentRound(),
      },
    });
  }
}

/**
 * 给模型的自定义工具：向用户提出带选项的问题并等待选择。
 * 回答/跳过/超时后，用文本结果把选择交回模型。
 */
export function createClarificationTool(hub: ClarificationHub) {
  return defineTool({
    name: CLARIFICATION_TOOL,
    label: '澄清提问',
    description:
      '向用户提出带选项的问题并等待其选择；调用会阻塞当前轮，直到用户回答、跳过或超时。可在需要用户决定、偏好或补充信息时使用。',
    promptSnippet: '向用户提问并等待选择；用于需要用户决定或补充信息时',
    parameters: Type.Object({
      intro: Type.Optional(Type.String({ description: '一句话说明为什么先问，最多 60 字' })),
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: '问题本身，最多 80 字' }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: '选项文案（尽量 ≤12 字，细节放 description）' }),
              value: Type.Optional(Type.String({ description: '回传给模型的值；缺省用 label' })),
              description: Type.Optional(Type.String({ description: '可选的补充说明' })),
            }),
            { minItems: 2, maxItems: 4 },
          ),
          allowOther: Type.Optional(Type.Boolean({ description: '是否允许「其他」自由输入，默认 true' })),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const outcome = await hub.request(
        {
          ...(params.intro ? { intro: params.intro } : {}),
          questions: params.questions.map((question) => ({
            text: question.question,
            allowOther: question.allowOther ?? true,
            options: question.options.map((option) => ({
              label: option.label,
              ...(option.value ? { value: option.value } : {}),
              ...(option.description ? { description: option.description } : {}),
            })),
          })),
        },
        signal,
      );

      if (outcome.status === 'answered') {
        const lines = outcome.questions.map(
          (question) => `- ${question.text} → ${outcome.answers[question.id] ?? '未指定'}`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `用户已完成澄清，请严格按这些选择继续写作：\n${lines.join('\n')}\n\n直接改写 MAIN.md；如果某项是「未指定」，按最合理判断写并在文末列出「待确认」。`,
            },
          ],
          details: { answers: outcome.answers, reason: '' },
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `用户没有回答澄清问题（${outcome.reason}）。请按最合理的假设继续写作，并在文末列出「待确认」项；不要再次调用 request_clarification。`,
          },
        ],
        details: { answers: {}, reason: outcome.reason },
      };
    },
  });
}
