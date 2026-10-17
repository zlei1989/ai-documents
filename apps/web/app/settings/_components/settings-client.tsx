'use client';
import { useEffect, useState } from 'react';
import { cn } from '@aidocs/ui';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  settingsTabFromHash,
  withSettingsTab,
  type SettingsTab,
} from '../../_lib/settings-tabs';
import { McpTab } from './mcp-tab';
import { ProvidersTab } from './providers-tab';
import { ResearchTab } from './research-tab';
import { SkillsTab } from './skills-tab';
import { StorageTab } from './storage-tab';
import { ToastProvider } from './toast';
import { TypesTab } from './types-tab';

export function SettingsClient() {
  const [tab, setTab] = useState<SettingsTab>(DEFAULT_SETTINGS_TAB);

  // 分区跟 URL 的 hash 保持一致：首帧读 hash（服务端渲染时拿不到），之后
  // 浏览器前进/后退或手动改 hash 也跟着切。于是 /settings#types 这类深链
  // 依旧直达，刷新/收藏也不会弹回默认分区。
  useEffect(() => {
    const syncFromUrl = () => {
      const next = settingsTabFromHash(window.location.hash);
      if (next) setTab(next);
    };
    syncFromUrl();
    window.addEventListener('hashchange', syncFromUrl);
    window.addEventListener('popstate', syncFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncFromUrl);
      window.removeEventListener('popstate', syncFromUrl);
    };
  }, []);

  /** 切分区时写回 hash：replaceState 只记位置、不在历史里堆一串 tab，返回仍是上一页 */
  function selectTab(next: SettingsTab): void {
    setTab(next);
    const href = withSettingsTab(window.location.href, next);
    if (href !== window.location.href) {
      window.history.replaceState(window.history.state, '', href);
    }
  }

  return (
    <ToastProvider>
      <div className="flex min-h-dvh w-full flex-col gap-4 px-4 py-5 sm:px-6 md:flex-row md:gap-6 md:py-8 lg:px-8 xl:px-12">
        <aside className="w-full shrink-0 md:w-[clamp(180px,15vw,260px)]">
          <a href="/" className="text-xs text-zinc-400 hover:text-zinc-700">
            ← 返回创作
          </a>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="text-lg font-semibold tracking-tight">设置</h1>
            <p className="text-[11px] text-zinc-400">全局配置，local-first</p>
          </div>
          <nav
            className="mt-4 flex gap-1 overflow-x-auto pb-1 md:flex-col md:gap-1 md:overflow-visible md:pb-0"
            aria-label="设置分区"
          >
            {SETTINGS_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => selectTab(item.value)}
                aria-current={tab === item.value ? 'page' : undefined}
                className={cn(
                  'shrink-0 rounded-lg px-3 py-2 text-left transition-colors md:w-full',
                  tab === item.value
                    ? 'bg-white shadow-sm ring-1 ring-zinc-200'
                    : 'text-zinc-600 hover:bg-zinc-100',
                )}
              >
                <span className={cn('block whitespace-nowrap text-sm md:whitespace-normal', tab === item.value && 'font-medium')}>
                  {item.label}
                </span>
                <span className="block whitespace-nowrap text-[11px] text-zinc-400 md:whitespace-normal">{item.hint}</span>
              </button>
            ))}
          </nav>
          <p className="mt-6 hidden text-[11px] leading-relaxed text-zinc-400 md:block">
            模型解析顺序：会话临时 → 类型锁定 → 全局默认；任一层解析不到会报错并指回这里。
          </p>
        </aside>
        <section className="min-w-0 flex-1">
          {tab === 'providers' ? <ProvidersTab /> : null}
          {tab === 'storage' ? <StorageTab /> : null}
          {tab === 'types' ? <TypesTab /> : null}
          {tab === 'mcp' ? <McpTab /> : null}
          {tab === 'skills' ? <SkillsTab /> : null}
          {tab === 'research' ? <ResearchTab /> : null}
        </section>
      </div>
    </ToastProvider>
  );
}
