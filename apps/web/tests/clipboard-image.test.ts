import { describe, expect, it } from 'vitest';
import { canCopyImageToClipboard, parseSvgSize, rasterScale } from '../app/_lib/clipboard-image';

describe('clipboard-image', () => {
  it('优先用 SVG 的 width/height，支持 px 与单引号', () => {
    expect(parseSvgSize('<svg width="1200" height="800" viewBox="0 0 600 400"></svg>')).toEqual({
      width: 1200,
      height: 800,
    });
    expect(parseSvgSize("<svg width='640px' height='360px'></svg>")).toEqual({ width: 640, height: 360 });
  });

  it('百分比尺寸回退 viewBox，且不把 stroke-width 当成宽度', () => {
    expect(
      parseSvgSize('<svg stroke-width="4" width="100%" height="100%" viewBox="0 0 1024 768"></svg>'),
    ).toEqual({ width: 1024, height: 768 });
  });

  it('没有可用尺寸时返回 null', () => {
    expect(parseSvgSize('<svg width="100%" height="100%"></svg>')).toBe(null);
    expect(parseSvgSize('<svg viewBox="0 0 0 100"></svg>')).toBe(null);
    expect(parseSvgSize('<div></div>')).toBe(null);
    expect(parseSvgSize('')).toBe(null);
  });

  it('矢量图 2 倍、位图 1 倍，长边受上限约束', () => {
    expect(rasterScale(600, 400, true)).toBe(2);
    expect(rasterScale(600, 400, false)).toBe(1);
    expect(rasterScale(4000, 2000, true, 4096)).toBeCloseTo(1.024);
    expect(rasterScale(8000, 4000, false, 4096)).toBe(0.512);
    expect(rasterScale(0, 0, true)).toBe(1);
  });

  it('Node 环境没有剪贴板写入能力', () => {
    expect(canCopyImageToClipboard()).toBe(false);
  });
});
