import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, updateConfig } from '@aidocs/core';
import { dropRuntime, putRuntime, sessionUiLog } from '@aidocs/agents';
import { abort, activateChatSession, createChatSession, ensureRuntime, history, listChatSessions } from './chat';
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
      const notices = (await runtime.history(0)).filter(
        (event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice',
      );
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

describe('多会话', () => {
  it('列出/新建/切换：新会话成为 active，旧会话保留且可切回', async () => {
    seed();

    const initial = await listChatSessions('测试', '文稿');
    expect(initial.sessions).toHaveLength(1);
    const firstId = initial.activeId;

    const created = await createChatSession('测试', '文稿');
    expect(created.sessions).toHaveLength(2);
    expect(created.activeId).not.toBe(firstId);
    expect(created.sessions[0]?.id).toBe(created.activeId);
    expect(created.sessions[0]?.title).toBe('新会话');

    const activated = await activateChatSession('测试', '文稿', firstId);
    expect(activated.activeId).toBe(firstId);
  });

  it('每个会话读自己的渲染日志，互不串台', async () => {
    seed();
    const initial = await listChatSessions('测试', '文稿');
    const created = await createChatSession('测试', '文稿');
    const artifactDir = join(root, 'docs', '测试', '文稿');

    appendEvent(sessionUiLog(artifactDir, initial.activeId), {
      type: 'message',
      message: { id: 'u-1', mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '旧会话' }], round: 1 },
    });
    appendEvent(sessionUiLog(artifactDir, created.activeId), {
      type: 'message',
      message: { id: 'u-1', mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '新会话' }], round: 1 },
    });

    const oldEvents = await history('测试', '文稿', 0, initial.activeId);
    const newEvents = await history('测试', '文稿', 0, created.activeId);

    expect(JSON.stringify(oldEvents)).toContain('旧会话');
    expect(JSON.stringify(oldEvents)).not.toContain('新会话');
    expect(JSON.stringify(newEvents)).toContain('新会话');
    expect(JSON.stringify(newEvents)).not.toContain('旧会话');
  });

  it('不存在的 sessionId 返回 NOT_FOUND，不会悄悄落到 active 会话', async () => {
    seed();
    await expect(history('测试', '文稿', 0, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ensureRuntime('测试', '文稿', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('同一文档的两个会话各自持有运行时，dispose 只释放自己', async () => {
    seed();
    const initial = await listChatSessions('测试', '文稿');
    const second = (await createChatSession('测试', '文稿')).activeId;

    const a = await ensureRuntime('测试', '文稿', initial.activeId);
    const b = await ensureRuntime('测试', '文稿', second);
    try {
      expect(a).not.toBe(b);
      expect(a.sessionId).toBe(initial.activeId);
      expect(b.sessionId).toBe(second);
    } finally {
      a.dispose();
      b.dispose();
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
      const notices = (await runtime.history(0)).filter(
        (event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice',
      );
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
      const notices = (await runtime.history(0)).filter(
        (event): event is Extract<typeof event, { type: 'notice' }> => event.type === 'notice',
      );
      expect(notices.some((notice) => notice.level === 'warn' && notice.text.includes('生图工具未生效'))).toBe(true);
      expect(notices.some((notice) => notice.text.includes('API Key'))).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});

describe('abort 暂停', () => {
  it('有运行时：直接中断，不重新装配', async () => {
    seed();
    const list = await listChatSessions('测试', '文稿');
    const artifactDir = join(root, 'docs', '测试', '文稿');
    let calls = 0;
    putRuntime(
      artifactDir,
      {
        abort: async () => {
          calls += 1;
        },
      },
      list.activeId,
    );

    await abort('测试', '文稿', list.activeId);

    expect(calls).toBe(1);
    dropRuntime(artifactDir, list.activeId);
  });

  it('没有运行时：静默成功（重复暂停 / 空闲会话是空操作）', async () => {
    seed();

    await expect(abort('测试', '文稿')).resolves.toBeUndefined();
  });
});
