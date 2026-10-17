'use client';

import * as React from 'react';
import { ArrowUp, Braces, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import type { ArchifyAiResult, ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import { Button } from '@aidocs/ui';
import { formatJson, parseJsonObject } from './model';

export function ArchifyJsonPanel({
  type,
  ir,
  aiUrl,
  syncKey = 0,
  diagnostics,
  onApplyPreview,
  onOpenInteractiveView,
}: {
  type: ArchifyType;
  ir: Record<string, unknown>;
  /** POST 改图草稿的接口地址 */
  aiUrl: string;
  /** 父组件外部改写 IR（如校验自动修复）时递增，让 JSON 文本重新同步 */
  syncKey?: number;
  diagnostics: ArchifyDiagnostic[];
  /** 写回编辑器 IR 并立即刷新右侧预览 */
  onApplyPreview: (ir: Record<string, unknown>) => void;
  /** 在新标签打开当前图示的交互视图 */
  onOpenInteractiveView: () => void;
}) {
  const [text, setText] = React.useState(() => formatJson(ir));
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [instruction, setInstruction] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [aiSummary, setAiSummary] = React.useState<string | null>(null);
  const [aiOk, setAiOk] = React.useState(true);

  // 外部 IR 变化（撤销/排版/自动修复）且本地没改过时，同步 JSON 文本
  const irText = React.useMemo(() => formatJson(ir), [ir]);
  const lastIrText = React.useRef(irText);
  React.useEffect(() => {
    if (lastIrText.current === irText) return;
    lastIrText.current = irText;
    if (!dirty) setText(irText);
  }, [dirty, irText]);

  // 自动修复等强制回写：即使本地有草稿也换成新 IR
  const lastSyncKey = React.useRef(syncKey);
  React.useEffect(() => {
    if (lastSyncKey.current === syncKey) return;
    lastSyncKey.current = syncKey;
    lastIrText.current = irText;
    setText(irText);
    setDirty(false);
    setError(null);
    setAiSummary(null);
    setAiError(null);
  }, [irText, syncKey]);

  /** 解析通过则清掉错误、标记已应用；失败在面板内显示语法错误 */
  function parse(): Record<string, unknown> | null {
    try {
      const parsed = parseJsonObject(text);
      setError(null);
      setDirty(false);
      return parsed;
    } catch (nextError) {
      setError((nextError as Error).message);
      return null;
    }
  }

  function applyPreview(): void {
    const parsed = parse();
    if (parsed) onApplyPreview(parsed);
  }

  function format(): void {
    try {
      setText(formatJson(parseJsonObject(text)));
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }

  /** 一句话改 IR：直接把当前文本发给 pi 模型，拿结构化 IR 回填并刷新预览 */
  async function askAi(): Promise<void> {
    const prompt = instruction.trim();
    if (!prompt || asking) return;
    let current: Record<string, unknown>;
    try {
      current = parseJsonObject(text);
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
      return;
    }
    setAsking(true);
    setAiError(null);
    setAiSummary(null);
    try {
      const response = await fetch(aiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'edit', type, ir: current, instruction: prompt }),
      });
      const body = (await response.json().catch(() => null)) as (ArchifyAiResult & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error || `AI 请求失败（HTTP ${response.status}）`);
      setText(formatJson(body.ir));
      setDirty(false);
      setAiOk(body.ok);
      setAiSummary(body.summary || (body.ok ? '已更新' : '模型已返回，但仍有校验错误'));
      setInstruction('');
      onApplyPreview(body.ir);
    } catch (nextError) {
      setAiError((nextError as Error).message);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">IR JSON</span>
        <span className="text-[11px] text-zinc-400">保留全部高级字段</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenInteractiveView}
          title="在新标签页打开完整交互版"
          aria-label="打开完整交互版"
        >
          <ExternalLink size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={format}
          title="格式化 JSON：统一缩进与换行"
          aria-label="格式化 JSON"
        >
          <Braces size={16} />
        </Button>
        <Button onClick={applyPreview} disabled={!dirty} title="应用 JSON 并刷新右侧图示">
          应用到预览
        </Button>
      </div>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        className="min-h-[420px] flex-1 resize-none rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[12px] leading-relaxed text-zinc-800 outline-none focus:border-indigo-400"
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void askAi();
        }}
        className="flex shrink-0 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 focus-within:border-indigo-400"
      >
        <Sparkles size={14} className="shrink-0 text-indigo-500" />
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          disabled={asking}
          placeholder="一句话让 AI 改这份 IR，例如：把 Edge CDN 换成 API 网关"
          aria-label="AI 修改要求"
          className="h-8 min-w-0 flex-1 bg-transparent text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"
        />
        <button
          type="submit"
          disabled={asking || !instruction.trim()}
          title="发送"
          aria-label="发送修改要求"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-indigo-600 hover:bg-indigo-50 disabled:text-zinc-300 disabled:hover:bg-transparent"
        >
          {asking ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
        </button>
      </form>
      {asking ? <div className="text-[11px] text-indigo-600">AI 正在改 IR…</div> : null}
      {aiSummary ? (
        <div className={`text-[11px] ${aiOk ? 'text-emerald-600' : 'text-amber-600'}`}>
          {aiOk ? 'AI 已更新：' : 'AI 已返回，但仍有校验错误：'}
          {aiSummary}
        </div>
      ) : null}
      {aiError ? <div className="text-[11px] text-red-600">{aiError}</div> : null}

      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-2 text-[12px] text-red-700">{error}</div> : null}
      {diagnostics.length > 0 ? (
        <div className="max-h-28 overflow-auto rounded-md border border-red-200 bg-red-50 p-2 text-[11.5px] text-red-700">
          {diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.code}-${index}`}>
              <span className="font-mono text-[10.5px]">{diagnostic.code}</span> {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
