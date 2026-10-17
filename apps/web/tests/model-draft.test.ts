import { describe, expect, it } from 'vitest';
import { emptyModelDraft, modelDraftFrom, parseModelDraft } from '../app/settings/_lib/model-draft';

describe('手动模型表单', () => {
  it('名称必填并去除首尾空白', () => {
    expect(parseModelDraft({ ...emptyModelDraft(), id: '  ' })).toEqual({ ok: false, error: '名称不能为空' });
    expect(parseModelDraft({ ...emptyModelDraft(), id: '  gpt-4o-mini  ' })).toEqual({
      ok: true,
      model: { id: 'gpt-4o-mini', supportsImages: false },
    });
  });

  it('上下文窗口 / 最大输出 Tok 留空不写字段，支持 k/M 单位并换算成整数', () => {
    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm' })).toEqual({
      ok: true,
      model: { id: 'm', supportsImages: false },
    });
    expect(
      parseModelDraft({ id: 'm', contextWindow: '200000', maxOutputTokens: '8192', supportsImages: true }),
    ).toEqual({
      ok: true,
      model: { id: 'm', contextWindow: 200000, maxOutputTokens: 8192, supportsImages: true },
    });

    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', contextWindow: '300k', maxOutputTokens: '8K' })).toEqual({
      ok: true,
      model: { id: 'm', contextWindow: 300_000, maxOutputTokens: 8_000, supportsImages: false },
    });
    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', contextWindow: '1M', maxOutputTokens: '1.5m' })).toEqual({
      ok: true,
      model: { id: 'm', contextWindow: 1_000_000, maxOutputTokens: 1_500_000, supportsImages: false },
    });
    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', contextWindow: '1.5k', maxOutputTokens: '200,000' })).toEqual({
      ok: true,
      model: { id: 'm', contextWindow: 1_500, maxOutputTokens: 200_000, supportsImages: false },
    });
    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', contextWindow: '1 M' })).toEqual({
      ok: true,
      model: { id: 'm', contextWindow: 1_000_000, supportsImages: false },
    });

    for (const bad of ['0', '-1', '1.5', '1g', 'abc', '1.5.2m']) {
      expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', contextWindow: bad })).toEqual({
        ok: false,
        error: '上下文窗口格式不正确：可填正整数，或 300k / 1M 这类单位',
      });
    }
    expect(parseModelDraft({ ...emptyModelDraft(), id: 'm', maxOutputTokens: '0m' })).toEqual({
      ok: false,
      error: '最大输出 Tok 格式不正确：可填正整数，或 8k / 1M 这类单位',
    });
  });

  it('编辑时把已有模型转成草稿，未声明支持图像按关闭处理', () => {
    expect(
      modelDraftFrom({ id: 'm', contextWindow: 200_000, maxOutputTokens: 8_192, supportsImages: true }),
    ).toEqual({
      id: 'm',
      contextWindow: '200000',
      maxOutputTokens: '8192',
      supportsImages: true,
    });
    expect(modelDraftFrom({ id: 'm' }).supportsImages).toBe(false);
  });
});
