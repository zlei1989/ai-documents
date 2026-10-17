'use client';
import { useEffect, useRef, useState } from 'react';
import type { ModelInfo, ProviderView } from '@aidocs/contracts';
import { Badge, Button, Checkbox, Input, cn } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { emptyModelDraft, modelDraftFrom, parseModelDraft, type ModelDraft } from '../_lib/model-draft';
import { errorMessage } from '../_lib/use-loader';
import { Dialog, Field, InlineError, InlineHint } from './primitives';
import { useToast } from './toast';

/** 与 previewModels 的拼接保持一致：anthropic 的 Base URL 可以只填域名 */
function modelsEndpoint(provider: ProviderView): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  return provider.protocol === 'anthropic'
    ? `${base.endsWith('/v1') ? base : `${base}/v1`}/models`
    : `${base}/models`;
}

/** 128000 → 128k，1000000 → 1M；保留一位小数，完整数字放在 title 里 */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const million = value / 1_000_000;
    return `${Number.isInteger(million) ? million : million.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousand = value / 1_000;
    return `${Number.isInteger(thousand) ? thousand : thousand.toFixed(1)}k`;
  }
  return value.toLocaleString('zh-CN');
}

/**
 * 模型弹窗：上半是已录入列表（可编辑/删除），下半可手动添加；
 * 远端拉取仍是两步预览，勾选后才写入本地列表。
 */
export function ModelsDialog({
  provider,
  onClose,
  onChanged,
}: {
  provider: ProviderView;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [modelForm, setModelForm] = useState<ModelDraft | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [listError, setListError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [remote, setRemote] = useState<ModelInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [patching, setPatching] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const formOpen = modelForm !== null;
  const imported = new Set(provider.models.map((model) => model.id));
  const localModels = new Map(provider.models.map((model) => [model.id, model]));
  /** 远端返回了上下文、但本地已导入项还没有值：可一键补全（已有值不覆盖） */
  const missingContextModels: ModelInfo[] = (remote ?? []).flatMap((model) => {
    if (!imported.has(model.id) || model.contextWindow === undefined) return [];
    const local = localModels.get(model.id);
    if (!local || local.contextWindow !== undefined) return [];
    return [{ id: model.id, contextWindow: model.contextWindow }];
  });
  const remoteHasContext = (remote ?? []).some((model) => model.contextWindow !== undefined);

  useEffect(() => {
    if (!formOpen) return;
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [formOpen]);

  function openAdd() {
    setEditingModelId(null);
    setModelForm(emptyModelDraft());
    setFormError('');
  }

  function openEdit(model: ModelInfo) {
    setEditingModelId(model.id);
    setModelForm(modelDraftFrom(model));
    setFormError('');
  }

  function closeForm() {
    setModelForm(null);
    setEditingModelId(null);
    setFormError('');
  }

  async function saveForm(event: React.FormEvent) {
    event.preventDefault();
    if (!modelForm) return;
    const parsed = parseModelDraft(modelForm);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    if (!editingModelId && provider.models.some((model) => model.id === parsed.model.id)) {
      setFormError(`模型已存在：${parsed.model.id}，请点该行的「编辑」修改参数`);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.saveModel(provider.id, parsed.model);
      toast.success(editingModelId ? '模型已更新' : '模型已添加');
      closeForm();
      await onChanged();
    } catch (cause) {
      const message = errorMessage(cause);
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function removeModel(model: ModelInfo) {
    if (!window.confirm(`删除模型「${model.id}」？`)) return;
    setDeletingId(model.id);
    setListError('');
    try {
      await api.deleteModel(provider.id, model.id);
      if (editingModelId === model.id) closeForm();
      toast.success('模型已删除');
      await onChanged();
    } catch (cause) {
      const message = errorMessage(cause);
      setListError(message);
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  }

  async function preview() {
    setPreviewing(true);
    setRemoteError('');
    try {
      const list = await api.previewModels(provider.id);
      setRemote(list);
      setSelected(new Set());
    } catch (cause) {
      setRemoteError(errorMessage(cause));
    } finally {
      setPreviewing(false);
    }
  }

  function toggleModel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importSelected() {
    const models: ModelInfo[] = (remote ?? []).filter((model) => selected.has(model.id));
    if (models.length === 0) {
      setRemoteError('请至少勾选一个模型');
      return;
    }
    setImporting(true);
    setRemoteError('');
    try {
      await api.importModels(provider.id, models);
      toast.success(`已导入 ${models.length} 个模型`);
      setSelected(new Set());
      await onChanged();
    } catch (cause) {
      const message = errorMessage(cause);
      setRemoteError(message);
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  /** 只补缺失的上下文窗口，不碰手动填过的值 */
  async function patchContexts() {
    if (missingContextModels.length === 0) return;
    setPatching(true);
    setRemoteError('');
    try {
      await api.importModels(provider.id, missingContextModels);
      toast.success(`已补全 ${missingContextModels.length} 个模型的上下文窗口`);
      await onChanged();
    } catch (cause) {
      const message = errorMessage(cause);
      setRemoteError(message);
      toast.error(message);
    } finally {
      setPatching(false);
    }
  }

  return (
    <Dialog
      open
      wide
      title={`模型 · ${provider.name}`}
      description="管理这个供应商已录入的模型；可手动添加能力参数，也可从远端拉取。"
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="space-y-5">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              已录入模型 <Badge>{provider.models.length}</Badge>
            </div>
            <Button variant="outline" onClick={openAdd}>
              手动添加
            </Button>
          </div>
          <InlineError message={listError} />
          {provider.models.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-center text-sm text-zinc-500">
              还没有录入模型。可以从远端拉取，或手动添加。
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full min-w-[620px] text-sm">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                    <th className="px-3 py-2 font-normal">模型 ID</th>
                    <th className="px-3 py-2 font-normal">上下文窗口</th>
                    <th className="px-3 py-2 font-normal">最大输出 Tok</th>
                    <th className="px-3 py-2 font-normal">支持图像</th>
                    <th className="px-3 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {provider.models.map((model) => (
                    <tr key={model.id} className="border-b border-zinc-50 last:border-0">
                      <td className="max-w-[260px] px-3 py-2">
                        <div className="truncate font-mono text-xs" title={model.id}>
                          {model.id}
                        </div>
                        {model.name && model.name !== model.id ? (
                          <div className="truncate text-[11px] text-zinc-400">{model.name}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        {model.contextWindow !== undefined ? model.contextWindow.toLocaleString('zh-CN') : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        {model.maxOutputTokens !== undefined ? model.maxOutputTokens.toLocaleString('zh-CN') : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {model.supportsImages ? (
                          <Badge>支持</Badge>
                        ) : (
                          <span className="text-xs text-zinc-400" title="未声明，按不支持图像处理">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-0.5">
                          <Button variant="ghost" onClick={() => openEdit(model)}>
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            className="text-red-600"
                            disabled={deletingId === model.id}
                            onClick={() => void removeModel(model)}
                          >
                            {deletingId === model.id ? '删除中…' : '删除'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {modelForm ? (
          <form
            ref={formRef}
            noValidate
            className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3"
            onSubmit={(event) => void saveForm(event)}
          >
            <div className="text-sm font-medium">{editingModelId ? '编辑模型' : '手动添加模型'}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="名称" hint="供应商要求的 model ID，例如 gpt-4o-mini">
                <Input
                  value={modelForm.id}
                  readOnly={editingModelId !== null}
                  onChange={(event) => setModelForm({ ...modelForm, id: event.target.value })}
                  placeholder="例如：gpt-4o-mini"
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus={editingModelId === null}
                />
              </Field>
              <Field label="上下文窗口" hint="留空使用默认 200000；可填 256k / 1M（k=千，M=百万）">
                <Input
                  value={modelForm.contextWindow}
                  onChange={(event) => setModelForm({ ...modelForm, contextWindow: event.target.value })}
                  placeholder="200000 / 256k / 1M"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="最大输出 Tok" hint="留空使用默认 8192；可填 8k / 32k（k=千）">
                <Input
                  value={modelForm.maxOutputTokens}
                  onChange={(event) => setModelForm({ ...modelForm, maxOutputTokens: event.target.value })}
                  placeholder="8192 / 8k / 32k"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <label className="flex items-start gap-2 pt-5 text-xs text-zinc-600">
                <Checkbox
                  checked={modelForm.supportsImages}
                  onChange={(event) => setModelForm({ ...modelForm, supportsImages: event.target.checked })}
                />
                <span>
                  支持图像
                  <span className="block text-[11px] text-zinc-400">声明后允许把图片作为模型输入；不确定就关闭。</span>
                </span>
              </label>
            </div>
            <InlineError message={formError} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeForm}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? '保存中…' : editingModelId ? '保存' : '添加'}
              </Button>
            </div>
          </form>
        ) : null}

        <section className="space-y-2 border-t border-zinc-100 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">从远端拉取</div>
              <div className="text-[11px] text-zinc-400">
                用已保存的 Key 请求 <code className="text-[10px]">{modelsEndpoint(provider)}</code>；只预览，勾选后才写入本地模型列表。
              </div>
            </div>
            <Button variant="outline" onClick={() => void preview()} disabled={previewing}>
              {previewing ? '拉取中…' : remote ? '重新拉取' : '从远端拉取'}
            </Button>
          </div>
          <InlineError message={remoteError} />
          {remote ? (
            remote.length === 0 ? (
              <p className="rounded-lg border border-zinc-100 px-3 py-4 text-center text-sm text-zinc-500">
                远端没有返回模型。
              </p>
            ) : (
              <>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-zinc-100 p-2">
                  {remote.map((model) => {
                    const exists = imported.has(model.id);
                    return (
                      <label
                        key={model.id}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                          exists ? 'text-zinc-400' : 'hover:bg-zinc-50',
                        )}
                      >
                        <Checkbox
                          checked={exists || selected.has(model.id)}
                          disabled={exists}
                          onChange={() => toggleModel(model.id)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.id}</span>
                        {model.contextWindow !== undefined ? (
                          <span
                            className="shrink-0 text-[11px] text-zinc-500"
                            title={`上下文窗口 ${model.contextWindow.toLocaleString('zh-CN')}`}
                          >
                            上下文 {formatTokenCount(model.contextWindow)}
                          </span>
                        ) : null}
                        {model.name && model.name !== model.id ? (
                          <span className="truncate text-[11px] text-zinc-400">{model.name}</span>
                        ) : null}
                        {exists ? <Badge>已导入</Badge> : null}
                      </label>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <InlineHint>
                    已勾选 {selected.size} 个；已导入项不会重复添加。
                    {remoteHasContext ? ' 上下文会随导入写入配置。' : ' 远端没有返回上下文窗口，导入后可手动填写。'}
                  </InlineHint>
                  <div className="flex flex-wrap items-center gap-2">
                    {missingContextModels.length > 0 ? (
                      <Button
                        variant="outline"
                        onClick={() => void patchContexts()}
                        disabled={patching || importing}
                        title="把远端返回的上下文窗口写回已导入模型；已有值不覆盖"
                      >
                        {patching ? '补全中…' : `补全已导入 ${missingContextModels.length}`}
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => void importSelected()}
                      disabled={importing || patching || selected.size === 0}
                    >
                      {importing ? '导入中…' : `导入 ${selected.size}`}
                    </Button>
                  </div>
                </div>
              </>
            )
          ) : (
            <p className="text-xs text-zinc-400">还没有拉取远端列表。也可以直接在上方手动添加。</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
