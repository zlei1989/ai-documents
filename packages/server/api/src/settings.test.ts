import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropRuntime, putRuntime } from '@aidocs/agents';
import { readConfig } from '@aidocs/core';
import { getSettings, saveSettings } from './settings';
import { isolateConfigDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;

beforeEach(() => {
  env = isolateConfigDir();
});
afterEach(() => {
  env.restore();
  dropRuntime('fake-doc');
});

describe('设置', () => {
  it('默认值：自动提交开、AI 2s / 人工 8s、无默认模型、思考强度关、资料查询无开关', () => {
    const settings = getSettings();
    expect(settings.autoCommit).toBe(true);
    expect(settings.aiCommitDebounceMs).toBe(2000);
    expect(settings.humanCommitDebounceMs).toBe(8000);
    expect(settings.defaultModel).toBeNull();
    expect(settings.thinkingLevel).toBe('off');
    expect(settings.storageRoot).toBe('');
    expect(settings.research).toEqual({
      providerId: null,
      baseUrl: 'https://api.deepseek.com',
      count: 8,
      needContent: false,
      disabledSources: [],
    });
  });

  it('补丁只改动传入字段并落盘', () => {
    const next = saveSettings({ autoCommit: false, aiCommitDebounceMs: 500 });
    expect(next.autoCommit).toBe(false);
    expect(next.aiCommitDebounceMs).toBe(500);
    expect(next.humanCommitDebounceMs).toBe(8000);
    expect(readConfig().settings).toMatchObject({ autoCommit: false, aiCommitDebounceMs: 500 });
    expect(getSettings().autoCommit).toBe(false);
  });

  it('资料查询设置变化会释放在跑会话，其它设置变化不会', () => {
    let disposed = 0;
    putRuntime('fake-doc', {
      dispose: () => {
        disposed += 1;
      },
    });

    saveSettings({ autoCommit: false });
    expect(disposed).toBe(0);

    saveSettings({
      research: {
        providerId: null,
        baseUrl: 'https://api.deepseek.com',
        count: 5,
        needContent: false,
        disabledSources: [],
      },
    });
    expect(disposed).toBe(1);
    expect(getSettings().research.count).toBe(5);
  });

  it('思考强度落盘，变了才释放在跑会话（下一轮重建才会用上新档位）', () => {
    let disposed = 0;
    const putFakeRuntime = () =>
      putRuntime('fake-doc', {
        dispose: () => {
          disposed += 1;
        },
      });

    putFakeRuntime();
    saveSettings({ autoCommit: false });
    expect(disposed).toBe(0);

    saveSettings({ thinkingLevel: 'high' });
    expect(disposed).toBe(1);
    expect(getSettings().thinkingLevel).toBe('high');
    expect(readConfig().settings.thinkingLevel).toBe('high');

    // resetAllRuntimes 已经把会话摘掉；重新挂一个再验证「值没变就不动会话」
    putFakeRuntime();
    saveSettings({ thinkingLevel: 'high' });
    expect(disposed).toBe(1);

    saveSettings({ thinkingLevel: 'off' });
    expect(disposed).toBe(2);
    expect(getSettings().thinkingLevel).toBe('off');
  });
});
