import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestSessionFile, modelInputModalities, thinkingOptions } from './assembly';

describe('thinkingOptions', () => {
  it('不给或 off：不声明 reasoning，行为与加开关之前一致', () => {
    expect(thinkingOptions(undefined)).toEqual({ reasoning: false });
    expect(thinkingOptions('off')).toEqual({ reasoning: false });
  });

  it('低/中/高：声明模型能力并透传档位', () => {
    expect(thinkingOptions('low')).toEqual({ reasoning: true, level: 'low' });
    expect(thinkingOptions('medium')).toEqual({ reasoning: true, level: 'medium' });
    expect(thinkingOptions('high')).toEqual({ reasoning: true, level: 'high' });
  });

  it('只有声明了 reasoning 的模型才不会被 pi 的 clamp 压成 off', () => {
    // pi 的 getSupportedThinkingLevels()：model.reasoning 为假时只返回 ['off']，
    // 所以档位（level）和能力（reasoning）必须同时给，否则档位静默失效。
    for (const level of ['low', 'medium', 'high'] as const) {
      const options = thinkingOptions(level);
      expect(options.reasoning).toBe(true);
      expect(options.level).toBe(level);
    }
  });
});

describe('modelInputModalities', () => {
  it('默认只声明文本，开启「支持图像」后追加 image', () => {
    expect(modelInputModalities(undefined)).toEqual(['text']);
    expect(modelInputModalities(false)).toEqual(['text']);
    expect(modelInputModalities(true)).toEqual(['text', 'image']);
  });
});


describe('latestSessionFile', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('忽略 UI 日志，只选 pi 会话 JSONL', () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-sessions-'));
    writeFileSync(join(dir, 'ui.jsonl'), '');
    writeFileSync(join(dir, 'a.ui.jsonl'), '');
    writeFileSync(join(dir, '2026-01-01T00-00-00Z_old.jsonl'), '');
    writeFileSync(join(dir, '2026-01-02T00-00-00Z_new.jsonl'), '');
    expect(latestSessionFile(dir)).toBe(join(dir, '2026-01-02T00-00-00Z_new.jsonl'));
  });

  it('只有 UI 日志时返回 undefined（让调用方新建会话）', () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-sessions-'));
    writeFileSync(join(dir, 'ui.jsonl'), '');
    expect(latestSessionFile(dir)).toBeUndefined();
  });
});
