import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateConfig } from '@aidocs/core';
import { ensureRuntime } from './chat';
import { createDoc } from './docs';
import { importModels, saveProvider } from './providers';
import { setStorageRoot } from './storage';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;
let root: string;

beforeEach(() => {
  env = isolateConfigDir();
  root = mkdtempSync(join(tmpdir(), 'aidocs-chat-'));
});

afterEach(() => {
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

/** 一个最小可装配环境：存储根 + 类型 + 文档 + 一个假供应商（不会真发请求） */
function seed(): void {
  setStorageRoot(root);
  mkdirSync(join(root, 'types', '科普文章'), { recursive: true });
  writeFileSync(
    join(root, 'types', '科普文章', 'type.yaml'),
    'name: 科普文章\ndescription: ""\nmodel: null\nskills: []\nmcp: []\nresources: []\n',
    'utf8',
  );
  createDoc(root, { group: '测试', name: '文稿', type: '科普文章' });
  const provider = saveProvider({
    name: '假供应商',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
  });
  importModels(provider.id, [{ id: 'fake-model' }]);
}

function setResearch(patch: Partial<{ providerId: string | null }>): void {
  updateConfig((config) => {
    config.settings.research = { ...config.settings.research, ...patch };
  });
}

describe('ensureRuntime 的资料查询装配', () => {
  it('默认注入：有可用 DeepSeek 供应商时，会话自动拿到三个 research 工具', async () => {
    seed();

    const runtime = await ensureRuntime('测试', '文稿');
    try {
      expect(runtime.session.getActiveToolNames()).toEqual(
        expect.arrayContaining(['read', 'write', 'edit', 'ls', 'grep', 'research_search', 'research_fetch', 'research_save']),
      );
    } finally {
      runtime.dispose();
    }
  });

  it('配置不可用：降级为无工具 + 一条中文 warn notice，不阻塞创作', async () => {
    seed();
    setResearch({ providerId: 'missing' });

    const runtime = await ensureRuntime('测试', '文稿');
    try {
      expect(runtime.session.getActiveToolNames()).not.toContain('research_search');
      const notices = runtime
        .history(0)
        .filter((event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice');
      expect(notices.some((notice) => notice.level === 'warn' && notice.text.includes('资料查询未生效'))).toBe(true);
      expect(notices.some((notice) => notice.text.includes('missing'))).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('重建会话时续接最新会话文件，轮次从历史继续', async () => {
    seed();
    const first = await ensureRuntime('测试', '文稿');
    const sessionsDir = join(root, 'docs', '测试', '文稿', 'sessions');
    first.dispose();

    const second = await ensureRuntime('测试', '文稿');
    try {
      expect(second.session.getActiveToolNames()).toContain('read');
      // 续接用的是同一个会话文件（而不是新开一条）
      expect(second.session.sessionFile?.startsWith(sessionsDir)).toBe(true);
    } finally {
      second.dispose();
    }
  });
});

describe('ensureRuntime 的生图装配', () => {
  function setSeedream(patch: Record<string, unknown>): void {
    updateConfig((config) => {
      config.seedream = { ...config.seedream, ...patch };
    });
  }

  it('启用且配置完整时注册 seedream_image_generation', async () => {
    seed();
    setSeedream({ enabled: true, apiKey: 'sk-ark-test' });

    const runtime = await ensureRuntime('测试', '文稿');
    try {
      expect(runtime.session.getActiveToolNames()).toContain('seedream_image_generation');
    } finally {
      runtime.dispose();
    }
  });

  it('默认关闭时不注册生图工具，也不发提示', async () => {
    seed();

    const runtime = await ensureRuntime('测试', '文稿');
    try {
      expect(runtime.session.getActiveToolNames()).not.toContain('seedream_image_generation');
      const notices = runtime
        .history(0)
        .filter((event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice');
      expect(notices.some((notice) => notice.text.includes('生图工具未生效'))).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('启用但缺 key → 降级为无工具 + 中文 warn notice', async () => {
    seed();
    setSeedream({ enabled: true, apiKey: '' });

    const runtime = await ensureRuntime('测试', '文稿');
    try {
      expect(runtime.session.getActiveToolNames()).not.toContain('seedream_image_generation');
      const notices = runtime
        .history(0)
        .filter((event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice');
      expect(notices.some((notice) => notice.level === 'warn' && notice.text.includes('生图工具未生效'))).toBe(true);
      expect(notices.some((notice) => notice.text.includes('API Key'))).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});
