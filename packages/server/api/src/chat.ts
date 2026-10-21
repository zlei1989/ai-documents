import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  TypeManifestSchema,
  type ArtifactMeta,
  type ChatEvent,
  type ChatSession,
  type ChatSessionList,
} from '@aidocs/contracts';
import { clearDiagramEditNotes, readConfig, readDiagramEditNotes, readEventsAfter, type AppConfig } from '@aidocs/core';
import {
  ChatRuntime,
  SessionNotFoundError,
  composePrompt,
  createDocSession,
  findSessionFile,
  getRuntime,
  listDocSessions,
  liveSessionStatus,
  releaseIdleSessionRuntime,
  resolveDocSession,
  sessionUiLog,
  setActiveDocSession,
  touchDocSession,
} from '@aidocs/agents';
import { commitPathAsync, ensureStorageGitignore } from './storage';
import { resolveResearchConfig } from './research';
import { resolveSeedreamConfig } from './seedream';
import { resolveSkillCommand } from './skills';
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
  // 每个会话一份渲染日志；老仓库的 .gitignore 里只有旧版共享 ui.jsonl，打开文档时补齐
  try {
    ensureStorageGitignore(storageRoot);
  } catch {
    /* .gitignore 写不进去不影响聊天 */
  }
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

/** 会话不存在 / id 越界统一映射成 404，路由层不必关心 agents 的内部错误类型 */
async function resolveSession(doc: DocTarget, sessionId?: string) {
  try {
    return await resolveDocSession(doc.artifactDir, sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) throw new ServiceError('NOT_FOUND', error.message);
    throw error;
  }
}

export async function ensureRuntime(group: string, name: string, sessionId?: string): Promise<ChatRuntime> {
  const doc = resolveDoc(group, name);
  const session = await resolveSession(doc, sessionId);

  const config = readConfig();
  const { meta, manifest, typeDir, promptText } = readManifest(doc);
  const { provider, modelId } = pickProvider(config);
  const selectedMcp = config.mcpServers.filter((m) => m.enabled && manifest.mcp.includes(m.name));
  const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0]!;
  // 资料查询默认注入：配置可用就带上三个 research_* 工具；不可用则降级并提示
  const research = resolveResearchConfig(config);
  // 生图：启用且配置完整才注入 seedream_image_generation；启用但配置不完整则提示
  const seedream = resolveSeedreamConfig(config);
  // 每个会话各自续接自己的 pi 会话文件；找不到文件说明还没发过消息，交给 SDK 新建
  const sessionFile = findSessionFile(doc.artifactDir, session.id);

  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const runtime = await ChatRuntime.create({
    artifactDir: doc.artifactDir,
    sessionId: session.id,
    onSettled: () => {
      // 自动提交尊重设置；commit 走异步 git，别在事件循环里同步等大仓库
      if (!readConfig().settings.autoCommit) return;
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        const rel = join('docs', doc.group, doc.name);
        void commitPathAsync(doc.storageRoot, rel, `ai: ${doc.group}/${doc.name} · 本轮修改`).catch(() => {
          /* 提交失败不打断创作 */
        });
      }, config.settings.aiCommitDebounceMs);
      commitTimer.unref?.();
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
  sessionId?: string,
): Promise<{ status: 'sent' | 'queued' }> {
  // 显式 /skill:<name> 调用：只认当前类型勾选的技能，先把技能正文读出来，
  // 再把命令从用户文本里摘掉；用户消息仍原样展示 /skill:，只有发给模型的 prompt 会展开技能。
  const allowedSkills = new Set(readManifest(resolveDoc(group, name)).manifest.skills);
  const command = resolveSkillCommand(input.text, allowedSkills);
  const runtime = await ensureRuntime(group, name, sessionId);
  const manualDiagramEdits = readDiagramEditNotes(runtime.artifactDir);
  const prompt = composePrompt({
    ...input,
    text: command.text,
    ...(command.skill ? { skill: command.skill } : {}),
    ...(manualDiagramEdits.length > 0 ? { manualDiagramEdits } : {}),
  });
  const result = await runtime.send(input.text, {
    prompt,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.selections?.length ? { selections: input.selections } : {}),
  });
  // 首条消息顺便给会话起标题；只有 /skill:x 时用技能名，避免标题是一串命令
  await touchDocSession(runtime.artifactDir, runtime.sessionId, command.titleText);
  if (manualDiagramEdits.length > 0) {
    try {
      clearDiagramEditNotes(runtime.artifactDir, manualDiagramEdits.map((note) => note.path));
    } catch {
      /* 清理提醒失败不打断发送 */
    }
  }
  return { status: result };
}

export async function history(
  group: string,
  name: string,
  afterSeq: number,
  sessionId?: string,
): Promise<ChatEvent[]> {
  const doc = resolveDoc(group, name);
  const session = await resolveSession(doc, sessionId);
  const file = sessionUiLog(doc.artifactDir, session.id);
  if (!existsSync(file)) return [];
  return readEventsAfter(file, afterSeq);
}

/** 会话清单 + 服务端内存里的实时状态 */
async function sessionListOf(doc: DocTarget): Promise<ChatSessionList> {
  const index = await listDocSessions(doc.artifactDir);
  return {
    activeId: index.activeId,
    sessions: index.sessions.map((session): ChatSession => ({
      ...session,
      status: liveSessionStatus(doc.artifactDir, session.id),
    })),
  };
}

export async function listChatSessions(group: string, name: string): Promise<ChatSessionList> {
  return sessionListOf(resolveDoc(group, name));
}

/** 新建会话并切换过去；还没发消息的空会话也会出现在列表里 */
export async function createChatSession(group: string, name: string): Promise<ChatSessionList> {
  const doc = resolveDoc(group, name);
  const previous = (await listDocSessions(doc.artifactDir)).activeId;
  const created = await createDocSession(doc.artifactDir);
  // 旧会话空闲时释放运行时，避免每点一次「新建」都多留一份 MCP/模型上下文
  if (previous && previous !== created.id) releaseIdleSessionRuntime(doc.artifactDir, previous);
  return sessionListOf(doc);
}

/** 切换当前会话；之后的 events/messages 请求都应带上 session 参数 */
export async function activateChatSession(
  group: string,
  name: string,
  sessionId: string,
): Promise<ChatSessionList> {
  const doc = resolveDoc(group, name);
  const previous = (await listDocSessions(doc.artifactDir)).activeId;
  try {
    await setActiveDocSession(doc.artifactDir, sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) throw new ServiceError('NOT_FOUND', error.message);
    throw error;
  }
  if (previous && previous !== sessionId) releaseIdleSessionRuntime(doc.artifactDir, previous);
  return sessionListOf(doc);
}

/** 回答聊天里那张澄清卡：groupId 必须与当前等待中的提问一致 */
export async function answerClarification(
  group: string,
  name: string,
  groupId: string,
  answers: Record<string, string>,
  sessionId?: string,
): Promise<{ ok: true }> {
  const runtime = await ensureRuntime(group, name, sessionId);
  if (!runtime.answerClarification(groupId, answers)) {
    throw new ServiceError('CONFLICT', '这次澄清已失效或已回答，请重新发送消息让 AI 再问一次。');
  }
  return { ok: true };
}

/** 暂停当前会话的创作：没有在跑的运行时就是空操作，不为了 abort 现装配一份 */
export async function abort(group: string, name: string, sessionId?: string): Promise<void> {
  const doc = resolveDoc(group, name);
  const session = await resolveSession(doc, sessionId);
  const runtime = getRuntime<ChatRuntime>(doc.artifactDir, session.id);
  if (!runtime) return;
  await runtime.abort();
}

/** 供 SSE 路由订阅：返回 (listener) => unsubscribe */
export async function subscribeRuntime(group: string, name: string, sessionId?: string) {
  return ensureRuntime(group, name, sessionId);
}
