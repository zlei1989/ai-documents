'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, LayoutGrid, Redo2, RefreshCw, Save, Trash2, Undo2, X } from 'lucide-react';
import type { ArchifyAiResult, ArchifyDiagnostic, ArchifyDocument, ArchifyLayoutReport, ArchifyLayoutResult, ArchifyPreviewResult, ArchifyValidateResult } from '@aidocs/contracts';
import { Button, PaneResizer, cn, type PaneBounds } from '@aidocs/ui';
import { archifyAiUrl, archifyApiUrl, archifyLayoutUrl, archifyValidateUrl, archifyViewUrl, docBase } from '../../../_lib/asset-url';
import { Dialog } from '../../../_components/dialog';
import { ArchifyJsonPanel } from './_archify-editor/json-panel';
import { ArchifyPreviewFrame } from './_archify-editor/preview-frame';
import { formatJson } from './_archify-editor/model';

const HISTORY_LIMIT = 40;
/** 左右分栏宽度（IR JSON / 交互预览），与创作页、文档列表共用一套拖拽交互 */
const ASIDE_LAYOUT_KEY = 'aidocs.layout.archify';
const ASIDE_DEFAULT_W = 640;
const ASIDE_MIN_W = 360;
const ASIDE_MAX_W = 1100;
/** 右侧预览至少留出的宽度 */
const PREVIEW_MIN_W = 420;
/** PaneResizer 把手占位 */
const HANDLE_W = 6;

function asideBounds(viewportWidth: number): PaneBounds {
  const max = Math.max(ASIDE_MIN_W, Math.min(ASIDE_MAX_W, viewportWidth - PREVIEW_MIN_W - HANDLE_W));
  return { min: ASIDE_MIN_W, max };
}

function clampAsideWidth(width: number): number {
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const { min, max } = asideBounds(vw);
  return Math.min(max, Math.max(min, Math.round(width)));
}

export interface ArchifyEditorProps {
  group: string;
  name: string;
  /** assets/ 下完整路径，如 assets/diagrams/x.archify.json */
  sourcePath: string;
  alt: string;
  onClose: () => void;
  onSaved?: () => void;
}

async function readError(response: Response): Promise<{ message: string; diagnostics: ArchifyDiagnostic[] }> {
  try {
    const body = (await response.json()) as {
      error?: string;
      context?: { diagnostics?: ArchifyDiagnostic[] };
    };
    return { message: body?.error || `HTTP ${response.status}`, diagnostics: body?.context?.diagnostics ?? [] };
  } catch {
    return { message: `HTTP ${response.status}`, diagnostics: [] };
  }
}

/** 预览/校验/保存用的画质档位；跟随 IR 的 meta.quality_profile */
function qualityOf(ir: Record<string, unknown>): 'standard' | 'showcase' {
  const meta = ir.meta && typeof ir.meta === 'object' ? (ir.meta as Record<string, unknown>) : {};
  return meta.quality_profile === 'standard' ? 'standard' : 'showcase';
}

export function ArchifyEditor({ group, name, sourcePath, alt, onClose, onSaved }: ArchifyEditorProps) {
  const apiUrl = React.useMemo(() => archifyApiUrl(docBase(group, name), sourcePath), [group, name, sourcePath]);
  const validateUrl = React.useMemo(() => archifyValidateUrl(docBase(group, name)), [group, name]);
  const layoutUrl = React.useMemo(() => archifyLayoutUrl(docBase(group, name)), [group, name]);
  const aiUrl = React.useMemo(() => archifyAiUrl(docBase(group, name)), [group, name]);
  const previewEndpoint = React.useMemo(() => `${docBase(group, name)}/archify-preview`, [group, name]);
  const previewSeqRef = React.useRef(0);
  /** 已请求过预览的 IR 快照：手动「应用到预览」后，防抖 effect 不再重复请求同一份 */
  const previewRequestedRef = React.useRef('');
  /** 在途预览请求数：去重分支据此判断「预览更新中…」该不该收掉 */
  const previewInFlightRef = React.useRef(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [doc, setDoc] = React.useState<ArchifyDocument | null>(null);
  const [ir, setIr] = React.useState<Record<string, unknown>>({});
  const [baseline, setBaseline] = React.useState('');
  const [revision, setRevision] = React.useState('');
  const [diagnostics, setDiagnostics] = React.useState<ArchifyDiagnostic[]>([]);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [layoutReport, setLayoutReport] = React.useState<ArchifyLayoutReport | null>(null);
  const [normalizing, setNormalizing] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState('');
  const [previewing, setPreviewing] = React.useState(false);
  const [livePreview, setLivePreview] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [validating, setValidating] = React.useState(false);
  const [repairing, setRepairing] = React.useState(false);
  const [aiNotice, setAiNotice] = React.useState<string | null>(null);
  /** 递增让 JSON 面板丢弃本地草稿、重新读 ir（撤销/自动修复/放弃等） */
  const [jsonSyncKey, setJsonSyncKey] = React.useState(0);
  const [validateOk, setValidateOk] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [historyState, setHistoryState] = React.useState({ canUndo: false, canRedo: false });
  // null = 客户端尚未恢复本地记忆；首帧由 CSS 默认宽度兜底，避免水合不一致。
  const [asideW, setAsideW] = React.useState<number | null>(null);
  const historyRef = React.useRef<string[]>([]);
  const indexRef = React.useRef(0);
  const irSnapshot = React.useMemo(() => formatJson(ir), [ir]);
  const dirty = irSnapshot !== baseline;
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  const quality = React.useMemo(() => qualityOf(ir), [ir]);

  // 实时预览时「打开完整交互版」也打开当前草稿，而不是上次保存版本。
  const fullUrl = React.useMemo(() => {
    const target = previewUrl || archifyViewUrl(docBase(group, name), sourcePath, revision, false);
    return target.replace(/([?&])embed=1(&|$)/, '$1').replace(/[?&]$/, '');
  }, [previewUrl, group, name, sourcePath, revision]);

  const resetHistory = React.useCallback((nextIr: Record<string, unknown>) => {
    const snapshot = formatJson(nextIr);
    historyRef.current = [snapshot];
    indexRef.current = 0;
    setHistoryState({ canUndo: false, canRedo: false });
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setConflict(false);
    setSaveError(null);
    try {
      const response = await fetch(apiUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error((await readError(response)).message);
      const next = (await response.json()) as ArchifyDocument;
      setDoc(next);
      setIr(next.ir);
      setBaseline(formatJson(next.ir));
      setRevision(next.revision);
      setWarnings(next.warnings ?? []);
      setLayoutReport(next.layout ?? null);
      setDiagnostics([]);
      setValidateOk(false);
      setPreviewUrl(next.interactiveUrl);
      setPreviewing(false);
      setLivePreview(false);
      setPreviewError(null);
      setSavedAt(null);
      setAiNotice(null);
      setJsonSyncKey((key) => key + 1);
      resetHistory(next.ir);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, resetHistory]);

  React.useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const persistAsideWidth = React.useCallback((next: number) => {
    try {
      localStorage.setItem(ASIDE_LAYOUT_KEY, JSON.stringify({ asideW: next }));
    } catch {
      /* 隐私模式等写入失败时忽略 */
    }
  }, []);

  // 恢复上次拖拽的左右分栏宽度
  React.useEffect(() => {
    let saved: number | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(ASIDE_LAYOUT_KEY) ?? 'null') as { asideW?: unknown } | null;
      if (typeof raw?.asideW === 'number' && Number.isFinite(raw.asideW)) saved = raw.asideW;
    } catch {
      /* 本地记录损坏时回落默认宽度 */
    }
    setAsideW(clampAsideWidth(saved ?? ASIDE_DEFAULT_W));
  }, []);

  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 实时预览：validate + render 到 .aidocs 预览缓存；不写源/海报。
  const runPreview = React.useCallback(
    async (nextIr: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
      if (!doc) return;
      const seq = ++previewSeqRef.current;
      previewInFlightRef.current += 1;
      setPreviewing(true);
      setPreviewError(null);
      try {
        const response = await fetch(previewEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: doc.type, ir: nextIr, quality: qualityOf(nextIr) }),
          signal,
        });
        if (seq !== previewSeqRef.current) return;
        if (!response.ok) {
          const failure = await readError(response);
          throw new Error(failure.message);
        }
        const result = (await response.json()) as ArchifyPreviewResult;
        if (seq !== previewSeqRef.current) return;
        setDiagnostics(result.diagnostics ?? []);
        setLayoutReport(result.layout ?? null);
        if (result.warnings?.length) setWarnings(result.warnings);
        if (result.ok && result.previewUrl) {
          setPreviewUrl(result.previewUrl);
          setLivePreview(true);
          setValidateOk(true);
          setPreviewError(null);
        } else {
          setLivePreview(false);
          setValidateOk(false);
          setPreviewError('实时预览未更新：请先修正诊断。');
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        if (seq !== previewSeqRef.current) return;
        setLivePreview(false);
        setPreviewError(`实时预览失败：${(error as Error).message}`);
      } finally {
        previewInFlightRef.current = Math.max(0, previewInFlightRef.current - 1);
        if (seq === previewSeqRef.current) setPreviewing(false);
      }
    },
    [doc, previewEndpoint],
  );

  // 600ms 防抖；手动「应用到预览」已请求过的快照直接跳过，避免重复渲染。
  React.useEffect(() => {
    if (!doc) return;
    if (!dirty) {
      // 回到干净状态：作废在途预览，避免迟到的响应把 iframe 又切走
      previewSeqRef.current += 1;
      previewRequestedRef.current = '';
      setPreviewing(false);
      setLivePreview(false);
      setPreviewError(null);
      setPreviewUrl(doc.interactiveUrl);
      return;
    }
    const snapshot = formatJson(ir);
    if (previewRequestedRef.current === snapshot) {
      // 该快照已请求过（手动应用 / 上一次预览）：没有在途请求就收掉「预览更新中…」
      if (previewInFlightRef.current === 0) setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    // 作废在途预览，避免旧的响应盖住新内容
    previewSeqRef.current += 1;
    setPreviewing(true);
    setPreviewError(null);
    const timer = setTimeout(() => {
      previewRequestedRef.current = snapshot;
      void runPreview(ir, controller.signal);
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [doc, dirty, ir, previewEndpoint, runPreview]);

  const applyIr = React.useCallback((next: Record<string, unknown>) => {
    setIr(next);
    setValidateOk(false);
    const snapshot = formatJson(next);
    if (historyRef.current[indexRef.current] !== snapshot) {
      const history = historyRef.current.slice(0, indexRef.current + 1);
      history.push(snapshot);
      while (history.length > HISTORY_LIMIT) history.shift();
      historyRef.current = history;
      indexRef.current = history.length - 1;
      setHistoryState({ canUndo: indexRef.current > 0, canRedo: false });
    }
  }, []);

  const undo = React.useCallback(() => {
    if (indexRef.current <= 0) return;
    indexRef.current -= 1;
    const snapshot = historyRef.current[indexRef.current]!;
    setIr(JSON.parse(snapshot) as Record<string, unknown>);
    setJsonSyncKey((key) => key + 1);
    setHistoryState({ canUndo: indexRef.current > 0, canRedo: true });
  }, []);

  const redo = React.useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    indexRef.current += 1;
    const snapshot = historyRef.current[indexRef.current]!;
    setIr(JSON.parse(snapshot) as Record<string, unknown>);
    setJsonSyncKey((key) => key + 1);
    setHistoryState({ canUndo: true, canRedo: indexRef.current < historyRef.current.length - 1 });
  }, []);

  // 「应用到预览」：写回 IR（撤销/保存内容同步），立即刷新右侧图示。
  const applyJsonPreview = React.useCallback(
    (next: Record<string, unknown>) => {
      applyIr(next);
      previewRequestedRef.current = formatJson(next);
      void runPreview(next);
    },
    [applyIr, runPreview],
  );

  /** 「打开交互视图」：打开当前草稿（实时预览已更新时）或已保存版本的完整交互页。 */
  const openInteractiveView = React.useCallback(() => {
    window.open(fullUrl, '_blank', 'noopener,noreferrer');
  }, [fullUrl]);

  /** 校验失败后自动让 AI 修一次；修复结果写回草稿并刷新预览（不写盘） */
  const repairWithAi = React.useCallback(
    async (badIr: Record<string, unknown>, badDiagnostics: ArchifyDiagnostic[]) => {
      if (!doc || repairing) return;
      setRepairing(true);
      setSaveError(null);
      setAiNotice(null);
      try {
        const response = await fetch(aiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'repair', type: doc.type, ir: badIr, diagnostics: badDiagnostics }),
        });
        const body = (await response.json().catch(() => null)) as (ArchifyAiResult & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error || `HTTP ${response.status}`);
        applyIr(body.ir);
        setJsonSyncKey((key) => key + 1);
        setDiagnostics(body.diagnostics);
        setValidateOk(body.ok);
        if (body.ok) {
          setAiNotice(`AI 已修复校验错误${body.summary ? `：${body.summary}` : ''}`);
          previewRequestedRef.current = formatJson(body.ir);
          void runPreview(body.ir);
        } else {
          setAiNotice(`AI 修复后仍有 ${body.diagnostics.filter((item) => item.severity === 'error').length} 个错误`);
        }
      } catch (error) {
        setSaveError(`AI 自动修复失败：${(error as Error).message}`);
      } finally {
        setRepairing(false);
      }
    },
    [aiUrl, applyIr, doc, repairing, runPreview],
  );

  const validate = React.useCallback(async () => {
    if (!doc || validating || repairing) return;
    setValidating(true);
    setSaveError(null);
    setAiNotice(null);
    try {
      const response = await fetch(validateUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: doc.type, ir, quality }),
      });
      if (!response.ok) throw new Error((await readError(response)).message);
      const result = (await response.json()) as ArchifyValidateResult;
      setDiagnostics(result.diagnostics ?? []);
      setLayoutReport(result.layout ?? null);
      if (result.warnings?.length) setWarnings(result.warnings);
      setValidateOk(result.ok);
      if (result.ok) {
        setSaveError(null);
        return;
      }
      // 有错误：自动调用大模型修复一次（不递归，避免死循环）
      await repairWithAi(ir, result.diagnostics ?? []);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setValidating(false);
    }
  }, [doc, ir, quality, repairing, repairWithAi, validateUrl, validating]);

  const normalizeLayout = React.useCallback(async () => {
    if (!doc || normalizing || saving) return;
    setNormalizing(true);
    setSaveError(null);
    try {
      const response = await fetch(layoutUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: doc.type, ir }),
      });
      if (!response.ok) throw new Error((await readError(response)).message);
      const result = (await response.json()) as ArchifyLayoutResult;
      if (result.applied) {
        applyIr(result.ir);
        setJsonSyncKey((key) => key + 1);
      }
      setWarnings(result.warnings ?? []);
      if (!result.applied) setSaveError(result.warnings[0] ?? '当前图没有可自动调整的布局。');
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setNormalizing(false);
    }
  }, [applyIr, doc, ir, layoutUrl, normalizing, saving]);

  const save = React.useCallback(
    async (force = false) => {
      if (!doc || saving) return;
      previewSeqRef.current += 1;
      setSaving(true);
      setSaveError(null);
      setPreviewing(false);
      try {
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ir, baseRevision: revision, force, quality }),
        });
        if (response.status === 409) {
          setConflict(true);
          return;
        }
        if (!response.ok) {
          const failure = await readError(response);
          setSaveError(failure.message);
          if (failure.diagnostics.length > 0) setDiagnostics(failure.diagnostics);
          return;
        }
        const next = (await response.json()) as ArchifyDocument;
        setDoc(next);
        setIr(next.ir);
        setBaseline(formatJson(next.ir));
        setRevision(next.revision);
        setWarnings(next.warnings ?? []);
        setLayoutReport(next.layout ?? null);
        setDiagnostics([]);
        setValidateOk(false);
        setPreviewUrl(next.interactiveUrl);
        setPreviewing(false);
        setLivePreview(false);
        setPreviewError(null);
        setAiNotice(null);
        setJsonSyncKey((key) => key + 1);
        resetHistory(next.ir);
        setSavedAt(new Date().toLocaleTimeString());
        onSaved?.();
      } catch (error) {
        setSaveError((error as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [apiUrl, doc, ir, onSaved, quality, resetHistory, revision, saving],
  );

  const discard = React.useCallback(() => {
    if (!doc || !dirty || saving) return;
    if (!window.confirm('放弃未保存的修改？')) return;
    previewSeqRef.current += 1;
    setIr(doc.ir);
    setBaseline(formatJson(doc.ir));
    setRevision(doc.revision);
    setWarnings(doc.warnings ?? []);
    setLayoutReport(doc.layout ?? null);
    setDiagnostics([]);
    setValidateOk(false);
    setSaveError(null);
    setConflict(false);
    setPreviewUrl(doc.interactiveUrl);
    setPreviewing(false);
    setLivePreview(false);
    setPreviewError(null);
    setSavedAt(null);
    setAiNotice(null);
    setJsonSyncKey((key) => key + 1);
    resetHistory(doc.ir);
  }, [doc, dirty, resetHistory, saving]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) {
        if (event.key === 'Escape' && !saving) {
          if (!dirtyRef.current || window.confirm('有未保存修改，确定关闭？')) onClose();
        }
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      } else if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === 'z' && event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, redo, save, saving, undo]);

  function close(): void {
    if (dirty && !window.confirm('有未保存修改，确定关闭？')) return;
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white text-zinc-900">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-3">
        <button
          type="button"
          onClick={close}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          title="关闭"
        >
          <X size={16} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">Archify 图示</span>
            {doc ? <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{doc.type}</span> : null}
            {dirty ? <span className="text-[11px] text-amber-600">● 未保存</span> : null}
            {repairing ? <span className="text-[11px] text-indigo-600">AI 修复中…</span> : null}
            {previewing ? <span className="text-[11px] text-indigo-600">预览更新中…</span> : livePreview ? <span className="text-[11px] text-emerald-600">实时预览</span> : null}
            {validateOk && !livePreview ? <span className="text-[11px] text-emerald-600">校验通过</span> : null}
            {layoutReport ? (
              <span
                className={`hidden whitespace-nowrap text-[11px] lg:inline ${layoutReport.score >= 90 ? 'text-emerald-600' : 'text-amber-600'}`}
                title={[layoutReport.summary, ...layoutReport.issues.map((issue) => issue.message), ...warnings].join('\n')}
              >
                布局 {layoutReport.score} 分
                {layoutReport.issues.length > 0 ? ` · ${layoutReport.issues.length} 项建议` : ''}
              </span>
            ) : warnings.length > 0 ? (
              <span className="hidden whitespace-nowrap text-[11px] text-amber-600 lg:inline" title={warnings.join('\n')}>
                布局提示 {warnings.length} 条
              </span>
            ) : null}
            {savedAt ? <span className="text-[11px] text-zinc-400">已保存 {savedAt}</span> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-400">
            <span className="truncate">{alt || doc?.title || sourcePath}</span>
            {aiNotice ? (
              <span className="min-w-0 truncate text-indigo-600" title={aiNotice}>
                {aiNotice}
              </span>
            ) : null}
          </div>
        </div>
        <div className="min-w-0 flex-1" />
        <Button variant="ghost" onClick={undo} disabled={!historyState.canUndo || loading} title="撤销">
          <Undo2 size={14} className="mr-1" />
          撤销
        </Button>
        <Button variant="ghost" onClick={redo} disabled={!historyState.canRedo || loading} title="重做">
          <Redo2 size={14} className="mr-1" />
          重做
        </Button>
        {doc && (doc.type === 'architecture' || doc.type === 'workflow') ? (
          <Button
            variant="outline"
            onClick={() => void normalizeLayout()}
            disabled={loading || normalizing || saving}
            title="确定性重排：architecture 重摆坐标，workflow 补卡片尺寸"
          >
            <LayoutGrid size={14} className="mr-1" />
            {normalizing ? '排版中…' : '排版'}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => void validate()} disabled={loading || validating || repairing || saving}>
          <CheckCircle2 size={14} className="mr-1" />
          {repairing ? 'AI 修复中…' : validating ? '校验中…' : '校验'}
        </Button>
        <Button onClick={() => void save()} disabled={loading || saving || !dirty}>
          <Save size={14} className="mr-1" />
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button
          variant="outline"
          onClick={discard}
          disabled={loading || saving || !dirty}
          title="放弃未保存的修改（不关闭编辑器）"
        >
          <Trash2 size={14} className="mr-1" />
          放弃
        </Button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">加载 Archify 源…</div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-zinc-500">
          <AlertTriangle className="text-amber-500" size={24} />
          <div className="max-w-lg text-center">{loadError}</div>
          <Button variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={14} className="mr-1" /> 重新加载
          </Button>
        </div>
      ) : doc ? (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <aside
            style={asideW === null ? undefined : ({ '--archify-aside-w': `${asideW}px` } as React.CSSProperties)}
            className={cn(
              'flex min-h-[320px] w-full shrink-0 flex-col border-b border-zinc-200 lg:h-full lg:border-b-0 lg:border-r',
              asideW === null ? 'lg:w-[640px]' : 'lg:w-[var(--archify-aside-w)]',
            )}
          >
            <div className="min-h-0 flex-1 overflow-auto">
              <ArchifyJsonPanel
                type={doc.type}
                ir={ir}
                aiUrl={aiUrl}
                syncKey={jsonSyncKey}
                diagnostics={diagnostics}
                onApplyPreview={applyJsonPreview}
                onOpenInteractiveView={openInteractiveView}
              />
            </div>
            {saveError || previewError ? (
              <div className="shrink-0 border-t border-red-200 bg-red-50 p-2 text-[12px] text-red-700">{saveError || previewError}</div>
            ) : null}
          </aside>
          <PaneResizer
            edge="start"
            width={asideW}
            onChange={setAsideW}
            onCommit={persistAsideWidth}
            defaultWidth={() => ASIDE_DEFAULT_W}
            bounds={asideBounds}
            label="拖动调整 IR JSON 与预览的宽度（双击复位）"
            className="hidden lg:block"
          />
          <main className="flex min-h-[420px] min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <ArchifyPreviewFrame url={previewUrl || doc.interactiveUrl} revision={revision} />
            </div>
          </main>
        </div>
      ) : null}

      <Dialog
        open={conflict}
        onClose={() => setConflict(false)}
        title="源文件已更新"
        description="有人（或 AI）在你编辑期间改了这张 Archify 图。重新加载会丢弃当前草稿；覆盖会以你的版本保存。"
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConflict(false)}>
            取消
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setConflict(false);
              setReloadKey((key) => key + 1);
            }}
          >
            重新加载
          </Button>
          <Button
            onClick={() => {
              setConflict(false);
              void save(true);
            }}
          >
            覆盖保存
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
