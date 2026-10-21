import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepairEvent, RepairEventRecord, RepairSnapshot, RepairStatus } from '@aidocs/contracts';
import { buildRepairSession, type RepairSessionHandle } from '@aidocs/agents';
import { git, gitOperationInProgress, readConfig, unmergedPaths } from '@aidocs/core';
import { pickProvider } from './chat';
import { ServiceError } from './service-error';

interface RepairJob {
  id: string;
  root: string;
  files: string[];
  status: RepairStatus;
  events: RepairEventRecord[];
  subscribers: Set<(event: RepairEventRecord) => void>;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  session?: RepairSessionHandle['session'];
  abortRequested: boolean;
  timedOut: boolean;
  seq: number;
  /** 当前 assistant 文本的累积；message_end 时落成一条 text 事件 */
  text: string;
  tools: Map<string, { name: string; path?: string }>;
  timeout?: ReturnType<typeof setTimeout>;
  cleanup?: ReturnType<typeof setTimeout>;
}

const STORE_KEY = '__aidocs_git_repair_jobs__';
const store = globalThis as unknown as Record<string, Map<string, RepairJob> | undefined>;
store[STORE_KEY] ??= new Map<string, RepairJob>();
const jobs = store[STORE_KEY]!;

const MAX_EVENTS = 4_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_FINISHED_MS = 30 * 60 * 1000;

/** pi 修复冲突时追加在默认提示词后的规则 */
const REPAIR_SYSTEM_PROMPT = [
  '你是「我的文档」的 git 冲突修复助手。工作目录就是用户的文档仓库根目录。',
  '只处理用户列出的冲突文件；不要探索仓库、不要重构无关内容、不要执行 git 命令（你也没有 bash）。',
  '',
  '规则：',
  '1. 先用 read 读取每个冲突文件，理解 <<<<<<< / ======= / >>>>>>> 两侧各自的意图。',
  '2. 合并成一份完整文本：两边不冲突的内容都保留；同一处两种写法时选更完整、更新的，不要凭空编造事实。',
  '3. 删除所有冲突标记行，保留文件其余结构与格式（Markdown 标题、表格、链接、中文标点）。',
  '4. 只用 edit / write 修改列出的文件，不创建、删除、移动其它文件。',
  '5. 二进制冲突或无法判断的内容不要猜：明确说哪个文件处理不了，然后停下。',
  '6. 全部写完后不要再调用工具，用一段简短中文说明每个文件是怎么合并的。',
].join('\n');

/** 首次发给 pi 的任务；文件清单不是信任边界，写入仍受工具白名单限制 */
export function buildRepairPrompt(files: string[]): string {
  return [
    '【git 冲突修复】',
    '下面这些文件还没有解决 git 合并冲突：',
    ...files.map((file) => `- ${file}`),
    '',
    '请按系统提示里的规则逐个文件 read → 合并 → edit/write，最后说明合并结果。',
  ].join('\n');
}

/** 仍有冲突标记时追加的一轮提醒 */
export function buildFollowUpPrompt(files: string[]): string {
  return [
    'Git 仍认为下面这些文件未解决，或文件里还留着冲突标记：',
    ...files.map((file) => `- ${file}`),
    '',
    '请 read 后继续修，确保冲突标记全部删除、内容完整；只改这些文件。',
  ].join('\n');
}

/** 行首的 7 字符冲突标记；Markdown 的水平线不会被误判（必须同时出现开始与分隔标记） */
export function hasConflictMarkers(text: string): boolean {
  if (text.includes('\0')) return true; // 二进制冲突交给人工，别让模型写坏
  return hasTextConflictMarkers(text);
}

function hasTextConflictMarkers(text: string): boolean {
  const lines = text.split('\n');
  const starts = lines.some((line) => line.startsWith('<<<<<<<'));
  const middles = lines.some((line) => line.startsWith('======='));
  const ends = lines.some((line) => line.startsWith('>>>>>>>'));
  return (starts && middles) || (starts && ends) || (middles && ends);
}

/**
 * 文件里是否还留着冲突标记。
 * `binaryAsConflict` = true 时把 NUL 当「模型处理不了」；完成合并时索引已经认为解决，
 * 二进制文件应直接信任 Git，不再阻塞。
 */
function fileStillConflicted(root: string, rel: string, binaryAsConflict = true): boolean {
  const abs = join(root, rel);
  if (!existsSync(abs)) return false; // 删除也是一种解决
  try {
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\0')) return binaryAsConflict;
    return hasTextConflictMarkers(text);
  } catch {
    return true;
  }
}

function emit(job: RepairJob, event: RepairEvent): void {
  const record: RepairEventRecord = { ...event, seq: (job.seq += 1), at: new Date().toISOString() };
  job.events.push(record);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  for (const listener of job.subscribers) {
    try {
      listener(record);
    } catch {
      /* 单个订阅者失败不影响任务 */
    }
  }
}

function finish(job: RepairJob, status: RepairStatus, text: string): void {
  if (job.status !== 'running') return;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  if (status === 'error') job.error = text;
  emit(job, { type: 'status', status, text });
  if (job.timeout) clearTimeout(job.timeout);
  job.timeout = undefined;
  job.session?.dispose();
  job.session = undefined;
  if (job.cleanup) clearTimeout(job.cleanup);
  job.cleanup = setTimeout(() => jobs.delete(job.id), KEEP_FINISHED_MS);
  job.cleanup.unref?.();
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).trim() || '未知错误';
}

/** 修复过程中把 pi 的事件压成设置页能渲染的日志；不转发 thinking / 流式 token */
function projectSessionEvent(job: RepairJob, raw: unknown): void {
  const event = raw as Record<string, any>;
  switch (event.type) {
    case 'message_update': {
      const delta = event.assistantMessageEvent;
      if (delta?.type === 'text_delta') job.text += String(delta.delta ?? '');
      break;
    }
    case 'message_end': {
      const text = job.text.trim();
      job.text = '';
      if (text) emit(job, { type: 'text', text });
      break;
    }
    case 'tool_execution_start': {
      const toolCallId = String(event.toolCallId ?? '');
      const args = (event.args ?? {}) as Record<string, unknown>;
      const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined;
      job.tools.set(toolCallId, { name: String(event.toolName ?? 'tool'), ...(path ? { path } : {}) });
      emit(job, {
        type: 'tool',
        name: String(event.toolName ?? 'tool'),
        ...(path ? { path } : {}),
        status: 'running',
      });
      break;
    }
    case 'tool_execution_end': {
      const toolCallId = String(event.toolCallId ?? '');
      const known = job.tools.get(toolCallId);
      job.tools.delete(toolCallId);
      // read 的结果是整份文件内容，塞进抽屉只会刷屏；失败时仍保留原因
      const detail = known?.name === 'read' && !event.isError ? undefined : summarizeToolResult(event.result);
      emit(job, {
        type: 'tool',
        name: known?.name ?? String(event.toolName ?? 'tool'),
        ...(known?.path ? { path: known.path } : {}),
        status: event.isError ? 'error' : 'ok',
        ...(detail ? { detail } : {}),
      });
      break;
    }
    default:
      break;
  }
}

function summarizeToolResult(result: unknown): string | undefined {
  if (!result) return undefined;
  let text = '';
  if (typeof result === 'string') text = result;
  else if (typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      text = content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function stageConflicts(root: string, files: string[]): void {
  if (files.length === 0) return;
  git(root, ['add', '-A', '--', ...files], { timeoutMs: 60_000 });
}

/** 冲突全部 stage 完后完成合并提交；没有进行中的操作时返回 null */
export function completeMerge(root: string): string | null {
  if (!gitOperationInProgress(root)) return null;
  // 最后一道防线：已 stage 的文件里仍有冲突标记就不提交
  const staged = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const bad = staged.filter((file) => fileStillConflicted(root, file, false));
  if (bad.length > 0) {
    throw new ServiceError('CONFLICT', `这些文件仍含冲突标记，未提交合并：${bad.join('、')}`, { files: bad });
  }
  const args = ['commit', '--no-edit'];
  try {
    git(root, args, { timeoutMs: 60_000 });
  } catch {
    // 没配 git 身份时回退到应用身份（不写全局 config）
    git(root, ['-c', 'user.name=我的文档', '-c', 'user.email=aidocs@localhost', ...args], { timeoutMs: 60_000 });
  }
  return git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim() || null;
}

/**
 * pi 写完后收尾：能自动解决的先 stage，仍有标记就让 pi 再修一轮（最多 2 次追加），
 * 最后完成合并提交。任何一步失败都保留现场，交回设置页让人处理。
 */
async function finalize(job: RepairJob): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const conflicted = unmergedPaths(job.root);
    if (conflicted.length === 0) break;

    const unresolved = conflicted.filter((file) => fileStillConflicted(job.root, file));
    const resolved = conflicted.filter((file) => !unresolved.includes(file));
    if (resolved.length > 0) {
      stageConflicts(job.root, resolved);
      emit(job, { type: 'log', level: 'info', text: `已标记解决：${resolved.join('、')}` });
    }

    const remaining = unmergedPaths(job.root);
    if (remaining.length === 0) break;
    if (attempt >= 2) {
      throw new ServiceError('CONFLICT', `pi 未能解决全部冲突：${remaining.join('、')}`, { files: remaining });
    }
    emit(job, {
      type: 'log',
      level: 'warn',
      text: `还有 ${remaining.length} 个文件未解决，让 pi 再修一轮。`,
    });
    if (!job.session) throw new ServiceError('INTERNAL', 'pi 会话已结束，无法继续修复');
    await job.session.prompt(buildFollowUpPrompt(remaining));
    if (job.abortRequested) return;
  }

  const remaining = unmergedPaths(job.root);
  if (remaining.length > 0) {
    throw new ServiceError('CONFLICT', `仍存在冲突文件：${remaining.join('、')}`, { files: remaining });
  }

  const sha = completeMerge(job.root);
  if (sha) {
    emit(job, {
      type: 'text',
      text: `冲突已修复，合并已提交（${sha}）。请检查文档内容后再点「推送」。`,
    });
    finish(job, 'done', '冲突已修复，合并已提交');
  } else {
    emit(job, {
      type: 'text',
      text: '冲突标记已清理并暂存；当前没有进行中的合并，请检查后用「推送」上传。',
    });
    finish(job, 'done', '冲突已解决');
  }
}

async function runJob(job: RepairJob, provider: ReturnType<typeof resolveRepairProvider>): Promise<void> {
  try {
    const handle = await buildRepairSession({
      cwd: job.root,
      agentDir: provider.agentDir,
      provider: provider.input,
      systemPrompt: REPAIR_SYSTEM_PROMPT,
    });
    if (job.abortRequested) {
      handle.dispose();
      finish(job, 'aborted', '已中止修复');
      return;
    }
    job.session = handle.session;
    const unsubscribe = handle.session.subscribe((event: unknown) => {
      try {
        projectSessionEvent(job, event);
      } catch {
        /* 投影失败不打断修复 */
      }
    });
    emit(job, { type: 'log', level: 'info', text: 'pi 已启动，开始读取冲突文件…' });
    await handle.session.prompt(buildRepairPrompt(job.files));
    unsubscribe();
    if (job.abortRequested) {
      finish(job, 'aborted', '已中止修复，冲突现场保留');
      return;
    }
    if (job.timedOut) {
      finish(job, 'error', '修复超时（10 分钟），冲突现场保留');
      return;
    }
    await finalize(job);
    if (job.abortRequested && job.status === 'running') {
      finish(job, 'aborted', '已中止修复，冲突现场保留');
    }
  } catch (error) {
    if (job.abortRequested) finish(job, 'aborted', '已中止修复，冲突现场保留');
    else finish(job, 'error', `修复失败：${errorText(error)}`);
  }
}

function resolveRepairProvider(root: string): {
  agentDir: string;
  input: {
    id: string;
    name: string;
    protocol: 'anthropic' | 'openai';
    baseUrl: string;
    apiKey: string;
    modelId: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsImages?: boolean;
  };
} {
  const config = readConfig();
  const { provider, modelId } = pickProvider(config);
  const model = provider.models.find((item) => item.id === modelId) ?? provider.models[0]!;
  return {
    agentDir: config.settings.storageRoot || root,
    input: {
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
  };
}

/**
 * 为当前 storageRoot 启动一个 pi 修复任务。
 * 同一仓库只允许一个在跑任务；重复点击返回现有任务。
 */
export function startRepairJob(root: string): { id: string; files: string[] } {
  const files = unmergedPaths(root);
  if (files.length === 0) throw new ServiceError('VALIDATION', '当前没有待修复的冲突文件');

  for (const job of jobs.values()) {
    if (job.root === root && job.status === 'running') return { id: job.id, files: job.files };
  }

  // 先解析模型：没有可用供应商时不要留下一个「开始即失败」的空任务
  const provider = resolveRepairProvider(root);

  const id = `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: RepairJob = {
    id,
    root,
    files,
    status: 'running',
    events: [],
    subscribers: new Set(),
    startedAt: new Date().toISOString(),
    abortRequested: false,
    timedOut: false,
    seq: 0,
    text: '',
    tools: new Map(),
  };
  jobs.set(id, job);
  emit(job, { type: 'status', status: 'running', text: `开始修复 ${files.length} 个冲突文件` });
  job.timeout = setTimeout(() => {
    job.timedOut = true;
    emit(job, { type: 'log', level: 'error', text: '修复超时（10 分钟），正在中止 pi。' });
    void job.session?.abort().catch(() => {
      /* 中止失败也要让 runJob 走超时分支 */
    });
  }, MAX_TIMEOUT_MS);
  job.timeout.unref?.();

  void runJob(job, provider);
  return { id, files };
}

export function getRepairSnapshot(id: string): RepairSnapshot | null {
  const job = jobs.get(id);
  return job ? toSnapshot(job) : null;
}

function toSnapshot(job: RepairJob): RepairSnapshot {
  return {
    id: job.id,
    files: [...job.files],
    status: job.status,
    events: job.events.map((event) => ({ ...event })),
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** 先订阅再取快照（同一个同步块内完成，不会漏事件） */
export function attachRepair(
  id: string,
  listener: (event: RepairEventRecord) => void,
): { snapshot: RepairSnapshot; unsubscribe: () => void } | null {
  const job = jobs.get(id);
  if (!job) return null;
  const snapshot = toSnapshot(job);
  job.subscribers.add(listener);
  return {
    snapshot,
    unsubscribe: () => job.subscribers.delete(listener),
  };
}

export async function abortRepair(id: string): Promise<RepairSnapshot> {
  const job = jobs.get(id);
  if (!job) throw new ServiceError('NOT_FOUND', '修复任务不存在或已过期');
  if (job.status !== 'running') return toSnapshot(job);
  job.abortRequested = true;
  emit(job, { type: 'log', level: 'warn', text: '已请求中止 pi，等待当前工具结束…' });
  try {
    await job.session?.abort();
  } catch {
    /* 中止失败时 runJob 会按 abortRequested 收尾 */
  }
  return toSnapshot(job);
}

/** 放弃本次合并，回到拉取前的状态；只在没有修复任务在跑时允许 */
export function abortMerge(root: string): void {
  for (const job of jobs.values()) {
    if (job.root === root && job.status === 'running') {
      throw new ServiceError('CONFLICT', 'pi 正在修复冲突，请先中止修复再放弃合并');
    }
  }
  if (!gitOperationInProgress(root)) throw new ServiceError('VALIDATION', '当前没有进行中的合并');
  try {
    git(root, ['merge', '--abort'], { timeoutMs: 60_000 });
  } catch {
    try {
      git(root, ['rebase', '--abort'], { timeoutMs: 60_000 });
    } catch {
      throw new ServiceError('CONFLICT', '无法自动放弃合并，请到终端执行 git merge --abort');
    }
  }
}
