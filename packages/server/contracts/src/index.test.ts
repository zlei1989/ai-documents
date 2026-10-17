import { describe, expect, it } from 'vitest';
import { BlockSchema, ClarificationAnswerSchema, SendMessageSchema } from './index';

describe('SendMessageSchema', () => {
  it('selections 缺省为空数组', () => {
    expect(SendMessageSchema.parse({ text: '继续' }).selections).toEqual([]);
  });

  it('接受多处选区上下文', () => {
    const parsed = SendMessageSchema.parse({
      text: '按这两处改',
      selections: [
        { source: 'MAIN.md', chars: 4, preview: '网关架构', text: '网关架构' },
        { source: 'MAIN.md', chars: 2, preview: '路由', text: '路由' },
      ],
    });

    expect(parsed.selections).toHaveLength(2);
    expect(parsed.selections[1]?.text).toBe('路由');
  });

  it('拒绝负数字数与小数位数', () => {
    const base = { source: 'MAIN.md', preview: 'x', text: 'x' };
    expect(SendMessageSchema.safeParse({ text: 'x', selections: [{ ...base, chars: -1 }] }).success).toBe(false);
    expect(SendMessageSchema.safeParse({ text: 'x', selections: [{ ...base, chars: 1.5 }] }).success).toBe(false);
  });
});

describe('ClarificationBlockSchema', () => {
  const block = {
    kind: 'clarification',
    groupId: 'g-1',
    intro: '先确认三件事',
    questions: [
      {
        id: 'q1',
        text: '写给谁看？',
        options: [
          { label: '中学生', value: '中学生' },
          { label: '成年人', value: '成年人', description: '通勤随手读' },
        ],
      },
    ],
    status: 'pending',
  };

  it('接受澄清块，allowOther 默认 true', () => {
    const parsed = BlockSchema.parse(block);
    expect(parsed.kind).toBe('clarification');
    if (parsed.kind === 'clarification') expect(parsed.questions[0]?.allowOther).toBe(true);
  });

  it('选项少于 2 个时拒绝', () => {
    const invalid = {
      ...block,
      questions: [{ ...block.questions[0], options: [{ label: '只有一个', value: 'x' }] }],
    };
    expect(BlockSchema.safeParse(invalid).success).toBe(false);
  });

  it('answers 缺省为空对象，值长度有上限', () => {
    expect(ClarificationAnswerSchema.parse({ groupId: 'g-1' }).answers).toEqual({});
    expect(ClarificationAnswerSchema.safeParse({ groupId: 'g-1', answers: { q1: 'x'.repeat(501) } }).success).toBe(false);
  });
});


describe('ToolName', () => {
  it('接受 archify 工具块', () => {
    const parsed = BlockSchema.parse({ kind: 'tool', tool: 'archify', title: 'Archify 图示', status: 'ok' });
    expect(parsed.kind).toBe('tool');
  });
});
