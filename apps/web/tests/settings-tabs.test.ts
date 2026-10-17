import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_TAB,
  settingsTabFromHash,
  settingsTabHref,
  withSettingsTab,
} from '../app/_lib/settings-tabs';

describe('设置页分区地址', () => {
  it('hash 带不带 # 都能认出分区', () => {
    expect(settingsTabFromHash('#types')).toBe('types');
    expect(settingsTabFromHash('mcp')).toBe('mcp');
  });

  it('空值 / 未知分区返回 null，调用方保留当前分区', () => {
    expect(settingsTabFromHash('')).toBeNull();
    expect(settingsTabFromHash('#')).toBeNull();
    expect(settingsTabFromHash(undefined)).toBeNull();
    expect(settingsTabFromHash('#nope')).toBeNull();
  });

  it('默认分区地址保持干净的 /settings，其余分区带 hash', () => {
    expect(settingsTabHref(DEFAULT_SETTINGS_TAB)).toBe('/settings');
    expect(settingsTabHref('types')).toBe('/settings#types');
  });

  it('换分区只改 hash，pathname 与查询参数原样保留', () => {
    expect(withSettingsTab('http://localhost:3084/settings', 'types')).toBe(
      'http://localhost:3084/settings#types',
    );
    expect(withSettingsTab('http://localhost:3084/settings#mcp', 'skills')).toBe(
      'http://localhost:3084/settings#skills',
    );
    expect(withSettingsTab('http://localhost:3084/settings?from=docs#mcp', 'research')).toBe(
      'http://localhost:3084/settings?from=docs#research',
    );
    // 切回默认分区时把 hash 去掉，刷新后仍是默认页
    expect(withSettingsTab('http://localhost:3084/settings#mcp', DEFAULT_SETTINGS_TAB)).toBe(
      'http://localhost:3084/settings',
    );
  });

  it('地址与解析互逆：写进去的 hash 能原样读回来', () => {
    for (const tab of ['types', 'mcp', 'skills', 'research'] as const) {
      expect(settingsTabFromHash(new URL(settingsTabHref(tab), 'http://localhost').hash)).toBe(tab);
    }
  });
});
