/**
 * 设置页的分区清单与地址约定。
 *
 * 分区写在 hash 上（`/settings#types`）：既保留了深链直达（类型编辑器删除
 * 后回跳、「管理全部」等入口），也让浏览器记住当前分区——刷新、收藏、分享
 * 都停在同一页，而不是弹回默认的「模型供应商」。默认分区不写 hash，地址
 * 保持干净的 `/settings`。
 */
export const SETTINGS_TABS = [
  { value: 'providers', label: '模型供应商', hint: '密钥与模型' },
  { value: 'storage', label: '存储', hint: '目录与版本历史' },
  { value: 'types', label: '类型', hint: '新建 / 复制 / 删除' },
  { value: 'mcp', label: 'MCP', hint: '全局服务器' },
  { value: 'skills', label: 'Skills', hint: '双来源与启停' },
  { value: 'research', label: '资料查询', hint: 'DeepSeek 搜索 / 抓取' },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]['value'];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'providers';

/** 解析 hash（可带或不带 `#`）；空值或未知分区返回 null，由调用方保留当前分区 */
export function settingsTabFromHash(hash: string | null | undefined): SettingsTab | null {
  const value = (hash ?? '').replace(/^#/, '').trim();
  return SETTINGS_TABS.some((item) => item.value === value) ? (value as SettingsTab) : null;
}

/** 分区对应的设置页地址；默认分区不带 hash */
export function settingsTabHref(tab: SettingsTab): string {
  return tab === DEFAULT_SETTINGS_TAB ? '/settings' : `/settings#${tab}`;
}

/** 把当前地址的 hash 换成给定分区，保留 pathname 与查询参数 */
export function withSettingsTab(currentHref: string, tab: SettingsTab): string {
  const url = new URL(currentHref);
  url.hash = tab === DEFAULT_SETTINGS_TAB ? '' : tab;
  return url.href;
}
