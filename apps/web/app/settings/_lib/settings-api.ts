import { httpJson } from '@aidocs/base';
import type {
  GitStatus,
  GitSyncAction,
  GitSyncResult,
  McpImportRejection,
  McpImportStyle,
  McpProbeResult,
  McpServer,
  ModelInfo,
  ProviderView,
  Protocol,
  RepairSnapshot,
  ResearchSourceInfo,
  ResearchTestInput,
  ResearchTestResult,
  SeedreamPatch,
  SeedreamTestResult,
  SeedreamView,
  SettingsPatch,
  SkillContent,
  SkillRef,
  StorageState,
  TypeManifest,
} from '@aidocs/contracts';
import type { Settings } from '@aidocs/core';

/** GET /api/types 的行视图：目录名即 id，manifest 为 null 表示 type.yaml 无法解析 */
export interface TypeSummaryView {
  name: string;
  description: string;
  manifest: TypeManifest | null;
  resourceCount: number;
}

export interface CreateTypePayload {
  name: string;
  description?: string;
  /** 从现有类型整目录复制 */
  copyFrom?: string;
}

export interface ProviderPayload {
  id?: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;
}

export interface SettingsResponse {
  settings: Settings;
  storage: StorageState;
}

export interface McpImportApiResult {
  imported: number;
  servers: McpServer[];
  rejected: McpImportRejection[];
  style?: McpImportStyle;
}

export interface McpImportOptions {
  /** 先清空现有条目再导入（默认关；它删的是用户已有的配置） */
  clear?: boolean;
}

export const api = {
  listProviders: () => httpJson<ProviderView[]>('/api/providers'),
  createProvider: (input: ProviderPayload) =>
    httpJson<ProviderView>('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  updateProvider: (input: ProviderPayload) =>
    httpJson<ProviderView>('/api/providers', { method: 'PUT', body: JSON.stringify(input) }),
  deleteProvider: (id: string) =>
    httpJson<{ ok: boolean }>(`/api/providers?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewModels: (id: string) =>
    httpJson<ModelInfo[]>(`/api/providers/${encodeURIComponent(id)}/models/preview`, {
      method: 'POST',
    }),
  importModels: (id: string, models: ModelInfo[]) =>
    httpJson<ProviderView>(`/api/providers/${encodeURIComponent(id)}/models/import`, {
      method: 'POST',
      body: JSON.stringify({ models }),
    }),
  saveModel: (id: string, model: ModelInfo) =>
    httpJson<ProviderView>(`/api/providers/${encodeURIComponent(id)}/models`, {
      method: 'PUT',
      body: JSON.stringify(model),
    }),
  deleteModel: (id: string, modelId: string) =>
    httpJson<ProviderView>(
      `/api/providers/${encodeURIComponent(id)}/models?modelId=${encodeURIComponent(modelId)}`,
      { method: 'DELETE' },
    ),
  testProvider: (id: string) =>
    httpJson<{ reply: string; model: string; latencyMs: number }>(
      `/api/providers/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),

  getSettings: () => httpJson<SettingsResponse>('/api/settings'),
  updateSettings: (patch: SettingsPatch) =>
    httpJson<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  initStorage: () => httpJson<StorageState>('/api/storage/init', { method: 'POST' }),

  syncStorage: (action: GitSyncAction) =>
    httpJson<GitSyncResult>('/api/storage/sync', { method: 'POST', body: JSON.stringify({ action }) }),
  startRepair: () =>
    httpJson<{ id: string; files: string[]; committed?: boolean; sha?: string | null }>('/api/storage/repair', {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    }),
  abortRepair: (id: string) =>
    httpJson<RepairSnapshot>('/api/storage/repair', { method: 'POST', body: JSON.stringify({ action: 'abort', id }) }),
  abortMerge: () =>
    httpJson<{ git: GitStatus }>('/api/storage/repair', {
      method: 'POST',
      body: JSON.stringify({ action: 'abort-merge' }),
    }),
  getRepair: (id: string) =>
    httpJson<RepairSnapshot>(`/api/storage/repair?id=${encodeURIComponent(id)}`),

  testResearch: (input: ResearchTestInput = {}) =>
    httpJson<ResearchTestResult>('/api/research/test', { method: 'POST', body: JSON.stringify(input) }),
  listResearchSources: () => httpJson<ResearchSourceInfo[]>('/api/research/sources'),

  getSeedream: () => httpJson<SeedreamView>('/api/seedream'),
  saveSeedream: (patch: SeedreamPatch) =>
    httpJson<SeedreamView>('/api/seedream', { method: 'PUT', body: JSON.stringify(patch) }),
  testSeedream: () => httpJson<SeedreamTestResult>('/api/seedream/test', { method: 'POST' }),

  listMcp: () => httpJson<McpServer[]>('/api/mcp'),
  saveMcp: (server: McpServer) => httpJson<McpServer>('/api/mcp', { method: 'POST', body: JSON.stringify(server) }),
  importMcp: (servers: McpServer[], options: McpImportOptions = {}) =>
    httpJson<McpImportApiResult>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ servers, clear: options.clear }),
    }),
  importMcpText: (text: string, options: McpImportOptions = {}) =>
    httpJson<McpImportApiResult>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ text, clear: options.clear }),
    }),
  deleteMcp: (name: string) =>
    httpJson<{ ok: boolean }>(`/api/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  probeMcp: (input: { name: string } | { server: McpServer }) =>
    httpJson<McpProbeResult>('/api/mcp/probe', { method: 'POST', body: JSON.stringify(input) }),

  listSkills: () => httpJson<SkillRef[]>('/api/skills'),
  toggleSkill: (name: string, enabled: boolean) =>
    httpJson<SkillRef[]>('/api/skills/toggle', { method: 'PUT', body: JSON.stringify({ name, enabled }) }),
  skillContent: (name: string, origin: SkillRef['origin']) =>
    httpJson<SkillContent>(`/api/skills/content?name=${encodeURIComponent(name)}&origin=${origin}`),

  listTypes: () => httpJson<TypeSummaryView[]>('/api/types'),
  createType: (input: CreateTypePayload) =>
    httpJson<{ manifest: TypeManifest; prompt: string }>('/api/types', { method: 'POST', body: JSON.stringify(input) }),
  deleteType: (name: string) =>
    httpJson<{ ok: boolean }>(`/api/types/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
