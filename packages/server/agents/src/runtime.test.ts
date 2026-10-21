import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { appendEvent } from '@aidocs/core';
import { putSession } from './registry';
import { ChatRuntime, composePrompt, initialRound, initialStatus, projectToolImages } from './runtime';

describe('composePrompt', () => {
  it('把多处选区按顺序拼成带编号的内容块', () => {
    const prompt = composePrompt({
      text: '照着这两处改',
      selections: [
        { source: 'MAIN.md', chars: 4, preview: '网关架构', text: '网关架构' },
        { source: 'MAIN.md', chars: 2, preview: '路由', text: '路由' },
      ],
    });

    expect(prompt).toContain('【用户选中的文档内容 · 第 1/2 处】source=MAIN.md chars=4');
    expect(prompt).toContain('【用户选中的文档内容 · 第 2/2 处】source=MAIN.md chars=2');
    expect(prompt.indexOf('网关架构')).toBeLessThan(prompt.indexOf('路由'));
    expect(prompt.endsWith('照着这两处改')).toBe(true);
  });

  it('没有选区时只发用户文本', () => {
    expect(composePrompt({ text: '你好' })).toBe('你好');
    expect(composePrompt({ text: '你好', selections: [] })).toBe('你好');
  });

  it('把手动编辑过的图示提醒放在用户文本之前', () => {
    const prompt = composePrompt({
      text: '把入口改成统一入口',
      manualDiagramEdits: [{ path: 'assets/diagrams/a.svg', at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(prompt).toContain('【图示手动编辑提醒】');
    expect(prompt).toContain('- assets/diagrams/a.svg');
    expect(prompt.indexOf('【图示手动编辑提醒】')).toBeLessThan(prompt.indexOf('把入口改成统一入口'));
    expect(prompt.endsWith('把入口改成统一入口')).toBe(true);
  });

  it('显式技能块放在最前，正文与引用基准都带上，选区仍在用户文本之前', () => {
    const prompt = composePrompt({
      text: '照着这个风格画',
      skill: {
        name: 'ian-xiaohei',
        file: '/skills/ian-xiaohei/SKILL.md',
        baseDir: '/skills/ian-xiaohei',
        body: '# Ian\n\n画图。',
      },
      selections: [{ source: 'MAIN.md', chars: 2, preview: '网关', text: '网关' }],
    });

    expect(prompt.startsWith('<skill name="ian-xiaohei" location="/skills/ian-xiaohei/SKILL.md">')).toBe(true);
    expect(prompt).toContain('References are relative to /skills/ian-xiaohei.');
    expect(prompt).toContain('画图。');
    expect(prompt.indexOf('</skill>')).toBeLessThan(prompt.indexOf('【用户选中的文档内容'));
    expect(prompt.endsWith('照着这个风格画')).toBe(true);
  });
});

describe('initialRound', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('没有 ui.jsonl 时是 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-round-'));
    expect(initialRound(join(dir, 'sessions', 'ui.jsonl'))).toBe(0);
  });

  it('续接历史时接着最大轮次，避免 mergeKey 碰撞', () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-round-'));
    const log = join(dir, 'ui.jsonl');
    appendEvent(log, {
      type: 'message',
      message: { id: 'u-1', mergeKey: 'u-1', role: 'user', blocks: [{ kind: 'text', text: '一' }], round: 1 },
    });
    appendEvent(log, {
      type: 'message',
      message: { id: 'a-3', mergeKey: 'a-3', role: 'assistant', blocks: [{ kind: 'text', text: '三' }], round: 3 },
    });
    appendEvent(log, { type: 'status', status: 'done' });

    expect(initialRound(log)).toBe(3);
  });
});

describe('initialStatus', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('续接已完成/出错日志时保留终态；运行态残留按空闲处理', () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-status-'));
    const doneLog = join(dir, 'done.ui.jsonl');
    const errorLog = join(dir, 'error.ui.jsonl');
    const runningLog = join(dir, 'running.ui.jsonl');
    appendEvent(doneLog, { type: 'status', status: 'running' });
    appendEvent(doneLog, { type: 'status', status: 'done' });
    appendEvent(errorLog, { type: 'status', status: 'error' });
    appendEvent(runningLog, { type: 'status', status: 'running' });

    expect(initialStatus(doneLog)).toBe('done');
    expect(initialStatus(errorLog)).toBe('error');
    expect(initialStatus(runningLog)).toBe('idle');
    expect(initialStatus(join(dir, 'missing.ui.jsonl'))).toBe('idle');
  });
});

describe('projectToolImages', () => {
  it('从 details.images 提取安全路径，过滤越界/非 assets、去重并保留 size', () => {
    const images = projectToolImages({
      details: {
        images: [
          { path: 'assets/images/a.jpg', alt: 'A', size: '2048x2048' },
          { path: 'assets/images/a.jpg', alt: '重复' },
          { path: 'assets/../secret.png', alt: 'bad' },
          { path: 'https://example.com/a.png', alt: 'remote' },
          { path: 'assets/images/b.png', alt: 'B' },
        ],
      },
    });
    expect(images).toEqual([
      { path: 'assets/images/a.jpg', alt: 'A', size: '2048x2048' },
      { path: 'assets/images/b.png', alt: 'B' },
    ]);
  });

  it('没有 details/images 或结构不对时返回空数组', () => {
    expect(projectToolImages(undefined)).toEqual([]);
    expect(projectToolImages({})).toEqual([]);
    expect(projectToolImages({ details: {} })).toEqual([]);
    expect(projectToolImages({ details: { images: 'x' } })).toEqual([]);
    expect(projectToolImages({ details: { images: [{ path: 1 }] } })).toEqual([]);
  });
});

describe('ChatRuntime 生图结果投影', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('tool_execution_end 把 details.images 追加到同一条工具消息并写入 ui.jsonl', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-runtime-images-'));
    let listener: ((event: unknown) => void) | null = null;
    const fake = {
      subscribe: (callback: (event: unknown) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
      dispose: () => {},
      abort: async () => {},
      prompt: async () => {},
      followUp: async () => 'sent',
      steer: async () => 'sent',
      getActiveToolNames: () => [],
      systemPrompt: '',
      sessionFile: undefined,
    };
    putSession(dir, fake as unknown as AgentSession);

    const runtime = await ChatRuntime.create({
      artifactDir: dir,
      typeDir: dir,
      agentDir: dir,
      manifest: { name: '测试', description: '', model: null, skills: [], mcp: [], resources: [] },
      provider: { id: 'p', name: 'P', protocol: 'openai', baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
    });
    const emit = listener as ((event: unknown) => void) | null;
    expect(emit).toBeTypeOf('function');

    emit!({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'seedream_image_generation', args: { prompt: '城市夜景' } });
    emit!({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'seedream_image_generation',
      isError: false,
      result: {
        content: [{ type: 'text', text: '已生成 2 张图片' }],
        details: {
          images: [
            { path: 'assets/images/城市夜景-1.jpg', alt: '城市夜景 第 1 张', size: '2048x2048' },
            { path: 'assets/images/城市夜景-2.jpg', alt: '城市夜景 第 2 张', size: '2048x2048' },
          ],
        },
      },
    });

    const messages = (await runtime.history(0)).filter(
      (event): event is Extract<typeof event, { type: 'message' }> => event.type === 'message',
    );
    const toolMessage = messages.filter((event) => event.message.mergeKey === 't-c1').at(-1)!;
    expect(toolMessage.message.blocks[0]).toMatchObject({
      kind: 'tool',
      tool: 'image',
      status: 'ok',
      title: '生图 · 城市夜景',
    });
    expect(toolMessage.message.blocks[1]).toEqual({
      kind: 'images',
      images: [
        { path: 'assets/images/城市夜景-1.jpg', alt: '城市夜景 第 1 张', size: '2048x2048' },
        { path: 'assets/images/城市夜景-2.jpg', alt: '城市夜景 第 2 张', size: '2048x2048' },
      ],
    });
    runtime.dispose();
  });
});

describe('ChatRuntime 流式快照节流', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fakeSession(onListener: (fn: ((event: unknown) => void) | null) => void) {
    const fake = {
      subscribe: (callback: (event: unknown) => void) => {
        onListener(callback);
        return () => onListener(null);
      },
      dispose: () => {},
      abort: async () => {},
      prompt: async () => {},
      followUp: async () => 'sent',
      steer: async () => 'sent',
      getActiveToolNames: () => [],
      systemPrompt: '',
      sessionFile: undefined,
    };
    return fake as unknown as AgentSession;
  }

  it('几十个 delta 合并成少量快照；message_end 立即落完整文本', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-runtime-stream-'));
    let emit: ((event: unknown) => void) | null = null;
    putSession(dir, fakeSession((fn) => (emit = fn)));

    const runtime = await ChatRuntime.create({
      artifactDir: dir,
      typeDir: dir,
      agentDir: dir,
      manifest: { name: '测试', description: '', model: null, skills: [], mcp: [], resources: [] },
      provider: { id: 'p', name: 'P', protocol: 'openai', baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
    });

    for (let i = 0; i < 60; i += 1) {
      emit!({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `第${i}段` } });
    }
    // 合并窗口内不写盘，避免每个 token 都产生一条快照
    expect((await runtime.history(0)).filter((event) => event.type === 'message')).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 220));
    const snapshots = (await runtime.history(0)).filter(
      (event): event is Extract<typeof event, { type: 'message' }> => event.type === 'message',
    );
    expect(snapshots.length).toBeLessThanOrEqual(3);
    const streamed = snapshots.at(-1)!.message.blocks[0] as { kind: string; text: string };
    expect(streamed.text).toContain('第59段');

    emit!({ type: 'message_end' });
    const final = (await runtime.history(0))
      .filter((event): event is Extract<typeof event, { type: 'message' }> => event.type === 'message')
      .at(-1)!;
    const block = final.message.blocks[0] as { kind: string; text: string; streaming?: boolean };
    expect(block.streaming).not.toBe(true);
    expect(block.text).toContain('第0段');
    expect(block.text).toContain('第59段');

    runtime.dispose();
  });

  it('非流式事件（状态）到来前先把积压快照落盘，seq 顺序不乱', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-runtime-order-'));
    let emit: ((event: unknown) => void) | null = null;
    putSession(dir, fakeSession((fn) => (emit = fn)));

    const runtime = await ChatRuntime.create({
      artifactDir: dir,
      typeDir: dir,
      agentDir: dir,
      manifest: { name: '测试', description: '', model: null, skills: [], mcp: [], resources: [] },
      provider: { id: 'p', name: 'P', protocol: 'openai', baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
    });

    emit!({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '先说话' } });
    emit!({ type: 'agent_start' });

    const events = await runtime.history(0);
    const messageIndex = events.findIndex((event) => event.type === 'message');
    const statusIndex = events.findIndex((event) => event.type === 'status');
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(messageIndex);
    expect(events.map((event) => event.seq)).toEqual([...events.map((event) => event.seq)].sort((a, b) => a - b));

    runtime.dispose();
  });
});

describe('ChatRuntime 暂停', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('abort 停掉当前 prompt：先按 settled 收尾，再把状态切回 idle 写进 ui.jsonl', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aidocs-runtime-abort-'));
    let aborts = 0;
    let emit: ((event: unknown) => void) | null = null;
    putSession(
      dir,
      {
        subscribe: (callback: (event: unknown) => void) => {
          emit = callback;
          return () => {
            emit = null;
          };
        },
        dispose: () => {},
        abort: async () => {
          aborts += 1;
          // 真实 pi 在 abort 里等 agent 变 idle，settle 事件先于 abort() resolve
          emit?.({ type: 'agent_settled' });
        },
        prompt: () => new Promise<void>(() => {}),
        followUp: async () => 'sent',
        steer: async () => 'sent',
        getActiveToolNames: () => [],
        systemPrompt: '',
        sessionFile: undefined,
      } as unknown as AgentSession,
    );

    const runtime = await ChatRuntime.create({
      artifactDir: dir,
      typeDir: dir,
      agentDir: dir,
      manifest: { name: '测试', description: '', model: null, skills: [], mcp: [], resources: [] },
      provider: { id: 'p', name: 'P', protocol: 'openai', baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
    });

    await runtime.send('写一篇长文', { prompt: '写一篇长文' });
    expect(runtime.getStatus()).toBe('running');

    await runtime.abort();

    expect(aborts).toBe(1);
    expect(runtime.getStatus()).toBe('idle');
    const statuses = (await runtime.history(0)).flatMap((event) => (event.type === 'status' ? [event.status] : []));
    expect(statuses).toEqual(['running', 'done', 'idle']);

    runtime.dispose();
  });
});
