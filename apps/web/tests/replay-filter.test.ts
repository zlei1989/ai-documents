import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage } from '@aidocs/contracts';
import { filterReplay } from '../app/api/_lib/replay-filter';

function message(input: Partial<ChatMessage> & Pick<ChatMessage, 'mergeKey' | 'role' | 'blocks'>): ChatEvent {
  return {
    type: 'message',
    seq: 0,
    at: '2026-01-01T00:00:00.000Z',
    message: { id: input.mergeKey, ...input } as ChatMessage,
  };
}

function status(value: 'running' | 'waiting' | 'done'): ChatEvent {
  return { type: 'status', seq: 0, at: '2026-01-01T00:00:00.000Z', status: value };
}

const user = message({ mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '写一篇' }], round: 1 });
const tool = message({
  mergeKey: 't-1',
  role: 'assistant',
  blocks: [{ kind: 'tool', tool: 'read', title: 'read · MAIN.md', status: 'ok' }],
  round: 1,
});
const thinking = message({
  mergeKey: 'th-1-1',
  role: 'assistant',
  blocks: [{ kind: 'thinking', text: '先看看文件' }],
  round: 1,
});
const intermediate = message({
  mergeKey: 'a-1-1',
  role: 'assistant',
  blocks: [{ kind: 'text', text: '我先看看文件。' }],
  round: 1,
});
const final = message({
  mergeKey: 'a-1-2',
  role: 'assistant',
  blocks: [{ kind: 'text', text: '写好了。' }],
  round: 1,
  final: true,
});
const clarification = message({
  mergeKey: 'cl-1',
  role: 'assistant',
  blocks: [
    {
      kind: 'clarification',
      groupId: 'g-1',
      questions: [
        {
          id: 'q1',
          text: '写给谁？',
          allowOther: true,
          options: [
            { label: '中学生', value: '中学生' },
            { label: '成年人', value: '成年人' },
          ],
        },
      ],
      status: 'answered',
      answers: { q1: '中学生' },
    },
  ],
  round: 1,
});

describe('filterReplay', () => {
  it('完成后刷新：只留用户消息、最终回复、已答复澄清卡', () => {
    const filtered = filterReplay([user, tool, thinking, intermediate, clarification, final, status('done')]);
    expect(filtered.filter((event) => event.type === 'message').map((event) => event.message.mergeKey)).toEqual([
      'u-1',
      'cl-1',
      'a-1-2',
    ]);
    expect(filtered.some((event) => event.type === 'status')).toBe(true);
  });

  it('运行中/等待中刷新：保留当前轮的全部过程，刷新后仍看得到实时进展', () => {
    for (const current of [status('running'), status('waiting')]) {
      const filtered = filterReplay([user, tool, thinking, intermediate, final, current]);
      const keys = filtered.filter((event) => event.type === 'message').map((event) => event.message.mergeKey);
      expect(keys).toEqual(['u-1', 't-1', 'th-1-1', 'a-1-1', 'a-1-2']);
    }
  });

  it('同一 mergeKey 的流式增量只回放最后一条', () => {
    const partial1 = message({
      mergeKey: 'a-1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '已' }],
      round: 1,
    });
    const partial2 = message({
      mergeKey: 'a-1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '已完成' }],
      round: 1,
      final: true,
    });
    const filtered = filterReplay([user, partial1, partial2, status('done')]);
    const messages = filtered.filter((event) => event.type === 'message');
    expect(messages.map((event) => event.message.mergeKey)).toEqual(['u-1', 'a-1']);
    const assistant = messages.find((event) => event.message.mergeKey === 'a-1');
    expect(assistant?.type).toBe('message');
    if (assistant?.type === 'message') {
      expect(assistant.message.blocks[0]).toMatchObject({ text: '已完成' });
    }
  });

  it('多轮时只保留最后一条 status，避免回放触发刷新循环', () => {
    const filtered = filterReplay([
      user,
      status('running'),
      final,
      status('done'),
      status('running'),
      status('done'),
    ]);
    const statuses = filtered.filter((event) => event.type === 'status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: 'done' });
  });

  it('旧会话没有 final：每轮最后一条文本消息兜底保留', () => {
    const legacy = message({
      mergeKey: 'a-1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '旧版最终回复' }],
      round: 1,
    });
    const filtered = filterReplay([user, tool, legacy, status('done')]);
    const keys = filtered.filter((event) => event.type === 'message').map((event) => event.message.mergeKey);
    expect(keys).toEqual(['u-1', 'a-1']);
  });

  it('多轮时只保留每轮最终回复与用户消息', () => {
    const user2 = message({ mergeKey: 'u-2', role: 'user', blocks: [{ kind: 'text', text: '再改一下' }], round: 2 });
    const final2 = message({
      mergeKey: 'a-2-1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: '改好了。' }],
      round: 2,
      final: true,
    });
    const filtered = filterReplay([user, final, user2, tool, final2, status('done')]);
    const keys = filtered.filter((event) => event.type === 'message').map((event) => event.message.mergeKey);
    expect(keys).toEqual(['u-1', 'a-1-2', 'u-2', 'a-2-1']);
  });

  it('带生图结果的消息在刷新后保留（含同一条里的工具卡）', () => {
    const images = message({
      mergeKey: 't-img',
      role: 'assistant',
      blocks: [
        { kind: 'tool', tool: 'image', title: '生图 · 城市夜景', status: 'ok' },
        {
          kind: 'images',
          images: [{ path: 'assets/images/城市夜景-1.jpg', alt: '城市夜景 第 1 张', size: '2048x2048' }],
        },
      ],
      round: 1,
    });
    const filtered = filterReplay([user, images, tool, final, status('done')]);
    const keys = filtered.filter((event) => event.type === 'message').map((event) => event.message.mergeKey);
    expect(keys).toEqual(['u-1', 't-img', 'a-1-2']);
  });
});
