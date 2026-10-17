import type { ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import { buildArchifyKit } from '@aidocs/archify';
import { buildPiModel, type PiProviderInput } from './assembly';

/**
 * Archify IR 的「一次性结构化改图」：直接走 pi 的模型接口 complete()，
 * 不装配 agent 会话、不注册工具。用于编辑器里的：
 * - 输入一句话改 JSON（edit）
 * - 校验失败后自动修复（repair）
 */

export interface ArchifyAiPromptInput {
  type: ArchifyType;
  ir: Record<string, unknown>;
  mode: 'edit' | 'repair';
  instruction?: string;
  diagnostics?: ArchifyDiagnostic[];
}

export interface ArchifyAiGeneration extends ArchifyAiPromptInput {
  provider: PiProviderInput;
  signal?: AbortSignal;
}

export interface ArchifyAiGenerationResult {
  ir: Record<string, unknown>;
  summary: string;
  model: string;
}

const SYSTEM_PROMPT = `你是 Archify 图示 IR 的编辑器。你只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。
固定回复格式：
{"summary":"一句中文说明改了什么","ir":{完整 Archify IR}}

硬性要求：
- ir 必须是完整对象（含 schema_version / diagram_type），不要只返回 diff 或改动片段。
- 保留用户没要求改的字段与 id，改动尽量小；不要改 meta.output。
- 不要引入 brand、meta.repository、sources 等离线字段。
- 诊断与规范冲突时以 schema 为准；确实改不了就原样返回 ir，并在 summary 里说明。
- 下面规范里的「只输出 JSON IR」指 ir 字段的内容；整个回复仍必须是 {"summary","ir"} 包装。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 从模型文本里取第一个 JSON 对象；容忍围栏和前后解释 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fence, trimmed].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      /* 继续截取 */
    }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      /* 继续 */
    }
  }
  throw new Error('模型没有返回合法 JSON');
}

export function parseArchifyAiReply(text: string): { ir: Record<string, unknown>; summary: string } {
  const parsed = extractJsonObject(text);
  if (!isRecord(parsed.ir)) throw new Error('模型回复缺少 ir 对象');
  return {
    ir: parsed.ir,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
  };
}

/** 诊断只保留对模型有用的字段，避免把整份证据塞进 prompt */
function compactDiagnostics(diagnostics: ArchifyDiagnostic[]): unknown[] {
  return diagnostics.slice(0, 20).map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(Object.keys(diagnostic.subject ?? {}).length > 0 ? { subject: diagnostic.subject } : {}),
    ...(diagnostic.supportedFixes.length > 0 ? { supportedFixes: diagnostic.supportedFixes } : {}),
  }));
}

export function buildArchifyAiMessages(input: ArchifyAiPromptInput): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${buildArchifyKit(input.type)}`;
  const ir = JSON.stringify(input.ir, null, 2);
  const task =
    input.mode === 'repair'
      ? [
          '任务：修复下面这份 Archify IR 的校验错误。',
          '只改与诊断相关的字段，保留其余内容；修好后给出完整 IR。',
          '诊断（JSON）：',
          JSON.stringify(compactDiagnostics(input.diagnostics ?? []), null, 2),
        ].join('\n')
      : [
          '任务：按用户要求修改下面这份 Archify IR。',
          `用户要求：${input.instruction?.trim() || '（未填写）'}`,
        ].join('\n');
  return {
    systemPrompt,
    userPrompt: `${task}\n\n类型：${input.type}\n当前 IR：\n${ir}`,
  };
}

async function completeOnce(input: ArchifyAiGeneration): Promise<ArchifyAiGenerationResult> {
  const { runtime, model } = await buildPiModel(input.provider);
  const { systemPrompt, userPrompt } = buildArchifyAiMessages(input);
  const message = await runtime.complete(
    model,
    {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
    },
    { timeoutMs: 60_000, maxRetries: 1, ...(input.signal ? { signal: input.signal } : {}) },
  );
  if (message.stopReason === 'error') {
    throw new Error(`模型调用失败：${message.errorMessage || '未知错误'}`);
  }
  if (message.stopReason === 'aborted') throw new Error('请求已取消');
  if (message.stopReason === 'length') throw new Error('模型输出被截断，请重试或缩小 IR');
  const text = message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('模型没有返回内容');
  const parsed = parseArchifyAiReply(text);
  return { ...parsed, model: `${input.provider.name}/${model.id}` };
}

/** 结构化改图：格式不合规时自动重问一次（不是校验重试） */
export async function generateArchifyIr(input: ArchifyAiGeneration): Promise<ArchifyAiGenerationResult> {
  try {
    return await completeOnce(input);
  } catch (error) {
    const message = (error as Error).message;
    const formatIssue = message.includes('合法 JSON') || message.includes('缺少 ir');
    if (!formatIssue || input.signal?.aborted) throw error;
    return completeOnce(input);
  }
}
