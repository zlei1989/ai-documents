import { describe, expect, it } from 'vitest';
import { buildArchifyAiMessages, extractJsonObject, parseArchifyAiReply } from './archify-ai';

describe('Archify AI 结构化回复', () => {
  it('解析裸 JSON、围栏和前后解释', () => {
    expect(parseArchifyAiReply('{"summary":"改了","ir":{"a":1}}')).toEqual({ summary: '改了', ir: { a: 1 } });
    expect(parseArchifyAiReply('```json\n{"summary":"围栏","ir":{"b":2}}\n```')).toEqual({
      summary: '围栏',
      ir: { b: 2 },
    });
    expect(extractJsonObject('先说明一下：{"summary":"解释","ir":{"c":3}} 结束')).toEqual({
      summary: '解释',
      ir: { c: 3 },
    });
  });

  it('缺少 ir 或不是合法 JSON 时报错', () => {
    expect(() => parseArchifyAiReply('{"summary":"没有 ir"}')).toThrow('缺少 ir');
    expect(() => parseArchifyAiReply('不是 JSON')).toThrow('合法 JSON');
  });

  it('edit prompt 带上要求、类型规范和完整 IR', () => {
    const { systemPrompt, userPrompt } = buildArchifyAiMessages({
      type: 'architecture',
      ir: { diagram_type: 'architecture', components: [] },
      mode: 'edit',
      instruction: '把入口改成网关',
    });
    expect(systemPrompt).toContain('{"summary"');
    expect(systemPrompt).toContain('# 类型：architecture');
    expect(userPrompt).toContain('把入口改成网关');
    expect(userPrompt).toContain('"diagram_type": "architecture"');
  });

  it('repair prompt 带诊断，且只保留关键字段', () => {
    const { userPrompt } = buildArchifyAiMessages({
      type: 'workflow',
      ir: { diagram_type: 'workflow' },
      mode: 'repair',
      diagnostics: [
        {
          code: 'schema/required',
          severity: 'error',
          message: '缺少 label',
          subject: { path: '/nodes/0' },
          evidence: { huge: 'x'.repeat(1000) },
          supportedFixes: ['补 label'],
        },
      ],
    });
    expect(userPrompt).toContain('schema/required');
    expect(userPrompt).toContain('缺少 label');
    expect(userPrompt).toContain('/nodes/0');
    expect(userPrompt).not.toContain('x'.repeat(100));
  });
});
