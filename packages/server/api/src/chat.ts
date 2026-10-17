import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TypeManifestSchema, type ArtifactMeta, type ChatEvent } from '@aidocs/contracts';
import { clearDiagramEditNotes, readConfig, readDiagramEditNotes, readEventsAfter, type AppConfig } from '@aidocs/core';
import { ChatRuntime, composePrompt, latestSessionFile } from '@aidocs/agents';
import { commitPath } from './storage';
import { resolveResearchConfig } from './research';
import { resolveSeedreamConfig } from './seedream';
import { ServiceError } from './service-error';

export interface DocTarget { storageRoot: string; group: string; name: string; artifactDir: string }

export function resolveDoc(group: string, name: string): DocTarget {
  const config = readConfig();
  const storageRoot = config.settings.storageRoot;
  if (!storageRoot) throw new ServiceError('VALIDATION', '尚未配置存储目录');
  const artifactDir = resolve(storageRoot, 'docs', group, name);
  const rel = relative(resolve(storageRoot), artifactDir);
  if (rel.startsWith('..')) throw new ServiceError('VALIDATION', '路径越界');
  if (!existsSync(artifactDir)) throw new ServiceError('NOT_FOUND', `文档不存在：${group}/${name}`);
  return { storageRoot, group, name, artifactDir };
}

/** 全局默认模型 → 供应商 + 模型；Archify 的一次性 AI 请求也用它 */
export function pickProvider(config: AppConfig): { provider: AppConfig['providers'][number]; modelId: string } {
  const withModels = config.providers.filter((p) => p.models.length > 0);
  if (withModels.length === 0) throw new ServiceError('VALIDATION', '还没有可用的供应商/模型，请先到设置页配置');
  const wanted = config.settings.defaultModel;
  if (wanted) {
    const [providerId, modelId] = wanted.split('/');
    const found = withModels.find((p) => p.id === providerId);
    if (found && modelId) return { provider: found, modelId };
  }
  const provider = withModels[0]!;
  return { provider, modelId: provider.models[0]!.id };
}

export function readManifest(doc: DocTarget): { meta: ArtifactMeta; manifest: ReturnType<typeof TypeManifestSchema.parse>; typeDir: string; promptText: string } {
  const metaRaw = readFileSync(join(doc.artifactDir, 'meta.yaml'), 'utf8');
  const meta = parseYaml(metaRaw) as ArtifactMeta;
  const typeDir = join(doc.storageRoot, 'types', meta.type);
  const manifestPath = join(typeDir, 'type.yaml');
  if (!existsSync(manifestPath)) throw new ServiceError('NOT_FOUND', `类型不存在：${meta.type}`);
  const manifest = TypeManifestSchema.parse(parseYaml(readFileSync(manifestPath, 'utf8')));
  const promptPath = join(typeDir, 'prompt.md');
  const promptText = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';
  return { meta, manifest, typeDir, promptText };
}

export async function ensureRuntime(group: string, name: string): Promise<ChatRuntime> {
  const doc = resolveDoc(group, name);

  const config = readConfig();
  const { meta, manifest, typeDir, promptText } = readManifest(doc);
  const { provider, modelId } = pickProvider(config);
  const selectedMcp = config.mcpServers.filter((m) => m.enabled && manifest.mcp.includes(m.name));
  const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0]!;
  // 资料查询默认注入：配置可用就带上三个 research_* 工具；不可用则降级并提示
  const research = resolveResearchConfig(config);
  // 生图：启用且配置完整才注入 seedream_image_generation；启用但配置不完整则提示
  const seedream = resolveSeedreamConfig(config);
  // 进程重启 / 设置变更后按 pi 规范续接最新会话文件，历史与模型上下文都不丢
  const sessionFile = latestSessionFile(join(doc.artifactDir, 'sessions'));

  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const runtime = await ChatRuntime.create({
    artifactDir: doc.artifactDir,
    onSettled: () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        try {
          const rel = join('docs', doc.group, doc.name);
          commitPath(doc.storageRoot, rel, `ai: ${doc.group}/${doc.name} · 本轮修改`);
        } catch {
          /* 提交失败不打断创作 */
        }
      }, 1500);
    },
    typeDir,
    manifest,
    mcp: selectedMcp,
    ...(research.state === 'ready' ? { research: research.config } : {}),
    ...(research.state === 'broken' ? { researchDisabledReason: research.reason } : {}),
    ...(seedream.state === 'ready' ? { seedream: seedream.config } : {}),
    ...(seedream.state === 'broken' ? { seedreamDisabledReason: seedream.reason } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    promptText,
    thinkingLevel: config.settings.thinkingLevel,
    agentDir: config.settings.storageRoot, // MCP/skills 配置目录暂用 storageRoot
    provider: {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: model.id,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      supportsImages: model.supportsImages ?? false,
    },
  });
  return runtime;
}

export async function sendMessage(
  group: string,
  name: string,
  input: {
    text: string;
    mode?: 'steer' | 'followUp';
    attachments?: { name: string; size: number; relPath: string }[];
    selections?: { source: string; chars: number; preview: string; text: string }[];
  },
): Promise<{ status: 'sent' | 'queued' }> {
  const runtime = await ensureRuntime(group, name);
  const manualDiagramEdits = readDiagramEditNotes(runtime.artifactDir);
  const prompt = composePrompt({
    ...input,
    ...(manualDiagramEdits.length > 0 ? { manualDiagramEdits } : {}),
  });
  const result = await runtime.send(input.text, {
    prompt,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.selections?.length ? { selections: input.selections } : {}),
  });
  if (manualDiagramEdits.length > 0) {
    try {
      clearDiagramEditNotes(runtime.artifactDir, manualDiagramEdits.map((note) => note.path));
    } catch {
      /* 清理提醒失败不打断发送 */
    }
  }
  return { status: result };
}

export function history(group: string, name: string, afterSeq: number): ChatEvent[] {
  const doc = resolveDoc(group, name);
  const file = join(doc.artifactDir, 'sessions', 'ui.jsonl');
  if (!existsSync(file)) return [];
  return readEventsAfter(file, afterSeq);
}

/** 回答聊天里那张澄清卡：groupId 必须与当前等待中的提问一致 */
export async function answerClarification(
  group: string,
  name: string,
  groupId: string,
  answers: Record<string, string>,
): Promise<{ ok: true }> {
  const runtime = await ensureRuntime(group, name);
  if (!runtime.answerClarification(groupId, answers)) {
    throw new ServiceError('CONFLICT', '这次澄清已失效或已回答，请重新发送消息让 AI 再问一次。');
  }
  return { ok: true };
}

export async function abort(group: string, name: string): Promise<void> {
  const runtime = await ensureRuntime(group, name);
  await runtime.abort();
}

/** 供 SSE 路由订阅：返回 (listener) => unsubscribe */
export async function subscribeRuntime(group: string, name: string) {
  return ensureRuntime(group, name);
}
