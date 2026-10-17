import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { McpServerSchema, ProviderSchema, ResearchSettingsSchema, SeedreamSettingsSchema, ThinkingLevelSchema } from '@aidocs/contracts';
import { configFile } from './paths';
import { atomicWrite } from './fs-safe';

export const SettingsSchema = z.object({
  storageRoot: z.string().default(''),
  autoCommit: z.boolean().default(true),
  /** 自动提交 debounce：AI 轮结束 2s / 人工保存 8s */
  aiCommitDebounceMs: z.number().int().min(0).default(2000),
  humanCommitDebounceMs: z.number().int().min(0).default(8000),
  disabledSkills: z.array(z.string()).default([]),
  defaultModel: z.string().nullable().default(null),
  /** 会话的思考强度（与默认模型同卡配置）；off = 不向供应商发推理参数，等同旧行为 */
  thinkingLevel: ThinkingLevelSchema.default('off'),
  /** 资料查询（DeepSeek Search/Fetch）配置；没有启用开关，旧 config.json 缺这一段时自动补默认值 */
  research: ResearchSettingsSchema.default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const AppConfigSchema = z.object({
  providers: z.array(ProviderSchema).default([]),
  mcpServers: z.array(McpServerSchema).default([]),
  settings: SettingsSchema.default({}),
  /** 生图（火山引擎 Seedream）；含密钥，GET /api/seedream 只回掩码 */
  seedream: SeedreamSettingsSchema.default({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function readConfig(): AppConfig {
  const file = configFile();
  if (!existsSync(file)) return AppConfigSchema.parse({});
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return AppConfigSchema.parse(JSON.parse(raw));
}

export function writeConfig(config: AppConfig): void {
  AppConfigSchema.parse(config);
  atomicWrite(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function updateConfig(mutate: (c: AppConfig) => void): AppConfig {
  const config = readConfig();
  mutate(config);
  writeConfig(config);
  return config;
}

/** 密钥掩码：只出不进 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 6) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
