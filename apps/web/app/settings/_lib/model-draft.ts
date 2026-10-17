import type { ModelInfo } from '@aidocs/contracts';

/** 手动添加/编辑模型的表单草稿：数值字段保留用户输入原文，提交时再校验 */
export interface ModelDraft {
  id: string;
  contextWindow: string;
  maxOutputTokens: string;
  supportsImages: boolean;
}

export type ModelDraftResult = { ok: true; model: ModelInfo } | { ok: false; error: string };

export function emptyModelDraft(): ModelDraft {
  return { id: '', contextWindow: '', maxOutputTokens: '', supportsImages: false };
}

export function modelDraftFrom(model: ModelInfo): ModelDraft {
  return {
    id: model.id,
    contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : '',
    supportsImages: model.supportsImages ?? false,
  };
}

/**
 * 留空 = 不写该字段（装配时回落默认值）。
 * 非空支持正整数或 k/K（千）、m/M（百万）单位，例如 300k、1M、1.5M；
 * 也会忽略千分位逗号与空格。
 */
function parseTokenCount(
  raw: string,
  error: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const text = raw.trim().replace(/[,，_\s]/g, '');
  if (!text) return { ok: true, value: undefined };
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text);
  if (!match) return { ok: false, error };
  const unit = (match[2] ?? '').toLowerCase();
  const value = Number(match[1]!) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1);
  if (!Number.isInteger(value) || value <= 0) return { ok: false, error };
  return { ok: true, value };
}

export function parseModelDraft(draft: ModelDraft): ModelDraftResult {
  const id = draft.id.trim();
  if (!id) return { ok: false, error: '名称不能为空' };
  const context = parseTokenCount(
    draft.contextWindow,
    '上下文窗口格式不正确：可填正整数，或 300k / 1M 这类单位',
  );
  if (!context.ok) return context;
  const maxOutput = parseTokenCount(
    draft.maxOutputTokens,
    '最大输出 Tok 格式不正确：可填正整数，或 8k / 1M 这类单位',
  );
  if (!maxOutput.ok) return maxOutput;
  return {
    ok: true,
    model: {
      id,
      ...(context.value !== undefined ? { contextWindow: context.value } : {}),
      ...(maxOutput.value !== undefined ? { maxOutputTokens: maxOutput.value } : {}),
      supportsImages: draft.supportsImages,
    },
  };
}
