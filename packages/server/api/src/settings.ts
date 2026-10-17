import { resetAllRuntimes } from '@aidocs/agents';
import { readConfig, updateConfig, type Settings } from '@aidocs/core';

export function getSettings(): Settings {
  return readConfig().settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  let next: Settings | undefined;
  let sessionChanged = false;
  updateConfig((config) => {
    const beforeResearch = JSON.stringify(config.settings.research);
    const beforeThinking = config.settings.thinkingLevel;
    config.settings = { ...config.settings, ...patch };
    next = config.settings;
    sessionChanged =
      JSON.stringify(config.settings.research) !== beforeResearch ||
      config.settings.thinkingLevel !== beforeThinking;
  });
  if (!next) throw new Error('保存设置失败');
  // 资料查询与思考强度都在会话装配时快照：释放在跑的会话，下一轮按新配置重建（历史靠会话文件续接）
  if (sessionChanged) resetAllRuntimes();
  return next;
}
