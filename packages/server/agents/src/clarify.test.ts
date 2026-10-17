import { describe, expect, it } from 'vitest';
import type { ChatEventDraft, ClarificationBlock, SessionStatus } from '@aidocs/contracts';
import { ClarificationHub } from './clarify';

function harness() {
  const events: ChatEventDraft[] = [];
  const statuses: SessionStatus[] = [];
  const hub = new ClarificationHub({ timeoutMs: 0 });
  hub.bind({
    publish: (event) => events.push(event),
    emitStatus: (status) => statuses.push(status),
    currentRound: () => 7,
  });
  const blocks = () =>
    events
      .filter((event): event is Extract<ChatEventDraft, { type: 'message' }> => event.type === 'message')
      .map((event) => event.message.blocks[0] as ClarificationBlock);
  return { hub, events, statuses, blocks };
}

const request = {
  intro: '先确认两件事',
  questions: [
    {
      text: '写给谁看？',
      options: [
        { label: '小学生', value: '小学生' },
        { label: '普通成年人', value: '普通成年人' },
      ],
    },
    {
      text: '想要什么语气？',
      options: [
        { label: '轻松故事型', value: '轻松故事型' },
        { label: '严谨解释型', value: '严谨解释型' },
      ],
    },
  ],
};

describe('ClarificationHub', () => {
  it('发出 pending 快照并切到 waiting；回答后发 answered 快照并切回 running', async () => {
    const { hub, statuses, blocks } = harness();
    const promise = hub.request(request);

    expect(statuses).toEqual(['waiting']);
    expect(blocks()).toHaveLength(1);
    const pending = blocks()[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.intro).toBe('先确认两件事');
    expect(pending.questions).toHaveLength(2);
    expect(hub.pendingCount).toBe(1);

    const [first, second] = pending.questions;
    expect(hub.answer(pending.groupId, { [first!.id]: '小学生', [second!.id]: '轻松故事型' })).toBe(true);
    const outcome = await promise;

    expect(outcome.status).toBe('answered');
    if (outcome.status === 'answered') {
      expect(outcome.answers[first!.id]).toBe('小学生');
      expect(outcome.answers[second!.id]).toBe('轻松故事型');
    }
    expect(statuses).toEqual(['waiting', 'running']);
    expect(blocks()[1]?.status).toBe('answered');
    expect(blocks()[1]?.answers?.[first!.id]).toBe('小学生');
    expect(hub.pendingCount).toBe(0);
  });

  it('已回答的 groupId 再提交返回 false', async () => {
    const { hub, blocks } = harness();
    const promise = hub.request(request);
    const groupId = blocks()[0]!.groupId;
    const [first, second] = blocks()[0]!.questions;
    expect(hub.answer(groupId, { [first!.id]: 'A', [second!.id]: 'B' })).toBe(true);
    await promise;
    expect(hub.answer(groupId, { [first!.id]: 'A', [second!.id]: 'B' })).toBe(false);
  });

  it('缺项按「未指定」补齐，保证每道题都有回答', async () => {
    const { hub, blocks } = harness();
    const promise = hub.request(request);
    const block = blocks()[0]!;
    expect(hub.answer(block.groupId, {})).toBe(true);
    const outcome = await promise;
    expect(outcome.status).toBe('answered');
    if (outcome.status === 'answered') {
      expect(Object.values(outcome.answers)).toEqual([
        '未指定（按最合理判断）',
        '未指定（按最合理判断）',
      ]);
    }
  });

  it('超时后发 expired 快照，并把「未回答」交回模型继续', async () => {
    const events: ChatEventDraft[] = [];
    const statuses: SessionStatus[] = [];
    const hub = new ClarificationHub({ timeoutMs: 10 });
    hub.bind({ publish: (event) => events.push(event), emitStatus: (status) => statuses.push(status), currentRound: () => 1 });
    const outcome = await hub.request(request);

    expect(outcome.status).toBe('expired');
    const messageEvents = events.filter(
      (event): event is Extract<ChatEventDraft, { type: 'message' }> => event.type === 'message',
    );
    const block = messageEvents.at(-1)!.message.blocks[0] as ClarificationBlock;
    expect(block.status).toBe('expired');
    expect(statuses).toEqual(['waiting', 'running']);
    expect(hub.pendingCount).toBe(0);
  });

  it('cancelAll 把等待中的问题标成 expired 并立即返回', async () => {
    const { hub, blocks } = harness();
    const promise = hub.request(request);
    hub.cancelAll('用户中断');
    const outcome = await promise;
    expect(outcome.status).toBe('expired');
    expect(blocks()[1]?.status).toBe('expired');
    expect(hub.answer(blocks()[0]!.groupId, {})).toBe(false);
  });
});
