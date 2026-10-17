'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Protocol, ProviderView, ThinkingLevel } from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, CardHeader, Input } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { ModelsDialog } from './models-dialog';
import { Dialog, Field, InlineError, InlineHint, Select, Spinner } from './primitives';
import { SeedreamCard } from './seedream-card';
import { useToast } from './toast';

interface ProviderForm {
  id?: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: ProviderForm = { name: '', protocol: 'openai', baseUrl: '', apiKey: '' };

const PROTOCOL_LABEL: Record<Protocol, string> = {
  openai: 'OpenAI Responses API',
  anthropic: 'Anthropic Messages API',
};

/** 思考强度：与 pi 的 ThinkingLevel 同名档位；off 表示不向供应商发推理参数 */
const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭（不思考）',
  low: '低',
  medium: '中',
  high: '高',
};
const THINKING_OPTIONS = (Object.keys(THINKING_LABEL) as ThinkingLevel[]).map((value) => ({
  value,
  label: THINKING_LABEL[value],
}));

export function ProvidersTab() {
  const toast = useToast();
  const providers = useLoader(api.listProviders);
  const settings = useLoader(api.getSettings);

  const [form, setForm] = useState<ProviderForm | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [modelTargetId, setModelTargetId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');

  const withModels = useMemo(
    () => (providers.data ?? []).filter((provider) => provider.models.length > 0),
    [providers.data],
  );
  /** 弹窗打开期间刷新 providers 后自动拿到最新模型列表 */
  const modelTarget = useMemo(
    () => (providers.data ?? []).find((provider) => provider.id === modelTargetId) ?? null,
    [providers.data, modelTargetId],
  );
  const savedDefault = settings.data?.settings.defaultModel ?? null;
  const savedThinking = settings.data?.settings.thinkingLevel ?? 'off';
  const [defaultProviderId, setDefaultProviderId] = useState('');
  const [defaultModelId, setDefaultModelId] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(savedThinking);

  useEffect(() => {
    if (!savedDefault) return;
    const slash = savedDefault.indexOf('/');
    if (slash <= 0) return;
    setDefaultProviderId(savedDefault.slice(0, slash));
    setDefaultModelId(savedDefault.slice(slash + 1));
  }, [savedDefault]);

  useEffect(() => {
    setThinkingLevel(savedThinking);
  }, [savedThinking]);

  const defaultProvider = withModels.find((provider) => provider.id === defaultProviderId);
  useEffect(() => {
    if (!defaultProvider) return;
    if (!defaultProvider.models.some((model) => model.id === defaultModelId)) {
      setDefaultModelId(defaultProvider.models[0]?.id ?? '');
    }
  }, [defaultProvider, defaultModelId]);

  async function saveDefaultModel() {
    if (!defaultProviderId) {
      toast.error('请先选择供应商');
      return;
    }
    if (!defaultModelId) {
      toast.error('请先选择模型');
      return;
    }
    try {
      await api.updateSettings({
        defaultModel: `${defaultProviderId}/${defaultModelId}`,
        thinkingLevel,
      });
      toast.success('默认模型已保存');
      await settings.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function clearDefaultModel() {
    try {
      await api.updateSettings({ defaultModel: null, thinkingLevel: 'off' });
      setDefaultProviderId('');
      setDefaultModelId('');
      setThinkingLevel('off');
      toast.success('默认模型已清除');
      await settings.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function openForm(provider?: ProviderView) {
    setFormError('');
    setForm(
      provider
        ? {
            id: provider.id,
            name: provider.name,
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            apiKey: '',
          }
        : { ...EMPTY_FORM },
    );
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setFormError('名称与 Base URL 不能为空');
      return;
    }
    if (!form.id && !form.apiKey.trim()) {
      setFormError('新建供应商必须填写 API Key');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      if (form.id) await api.updateProvider(payload);
      else await api.createProvider(payload);
      toast.success(form.id ? '供应商已更新' : '供应商已创建');
      setForm(null);
      await Promise.all([providers.reload(), settings.reload()]);
    } catch (error) {
      setFormError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeProvider(provider: ProviderView) {
    if (!window.confirm(`删除供应商「${provider.name}」？密钥与模型列表会一并删除。`)) return;
    try {
      await api.deleteProvider(provider.id);
      setRowError('');
      toast.success('供应商已删除');
      await Promise.all([providers.reload(), settings.reload()]);
    } catch (error) {
      setRowError(errorMessage(error));
      toast.error(errorMessage(error));
    }
  }

  async function runTest(provider: ProviderView) {
    setTestingId(provider.id);
    setRowError('');
    try {
      const result = await api.testProvider(provider.id);
      toast.success(`测试调用成功（${result.model} · ${result.latencyMs}ms）：${result.reply.slice(0, 60)}`);
    } catch (error) {
      setRowError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">默认模型</div>
            <div className="text-[11px] text-zinc-400">优先级最低：类型锁定与会话临时选择都会覆盖它</div>
          </div>
          {savedDefault ? <Badge>{savedDefault}</Badge> : <Badge>未设置</Badge>}
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select
            value={defaultProviderId}
            onChange={(value) => {
              setDefaultProviderId(value);
              const provider = withModels.find((item) => item.id === value);
              setDefaultModelId(provider?.models[0]?.id ?? '');
            }}
            options={[
              { value: '', label: '选择供应商' },
              ...withModels.map((provider) => ({ value: provider.id, label: provider.name })),
            ]}
            className="w-full sm:w-48"
          />
          <Select
            value={defaultModelId}
            onChange={setDefaultModelId}
            disabled={!defaultProvider}
            options={(defaultProvider?.models ?? []).map((model) => ({ value: model.id, label: model.id }))}
            className="w-full sm:w-64"
          />
          <Select
            value={thinkingLevel}
            onChange={(value) => setThinkingLevel(value as ThinkingLevel)}
            options={THINKING_OPTIONS}
            className="w-36"
            ariaLabel="思考强度"
          />
          <Button onClick={() => void saveDefaultModel()}>
            保存
          </Button>
          {savedDefault ? (
            <Button variant="ghost" onClick={() => void clearDefaultModel()}>
              清除
            </Button>
          ) : null}
          {defaultProviderId && !defaultProvider ? (
            <span className="text-xs text-amber-600">默认模型指向的供应商已不存在，请重新选择</span>
          ) : null}
          {withModels.length === 0 ? (
            <span className="text-xs text-zinc-400">先创建供应商并导入模型，才能设置默认模型</span>
          ) : null}
          {thinkingLevel !== 'off' ? (
            <span className="basis-full text-xs text-zinc-400">
              按所选档位向供应商发推理参数：模型不支持思考时请选「关闭」，否则请求会被拒。保存后下一轮自动重建会话。
            </span>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">模型供应商</div>
            <div className="text-[11px] text-zinc-400">API Key 只写不读；列表只回显掩码</div>
          </div>
          <Button onClick={() => openForm()}>
            新建供应商
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {providers.error ? (
            <div className="space-y-2 p-4">
              <InlineError message={providers.error} />
              <Button variant="outline" onClick={() => void providers.reload()}>
                重试
              </Button>
            </div>
          ) : null}
          {rowError ? (
            <div className="px-4 pt-3">
              <InlineError message={rowError} />
            </div>
          ) : null}
          {providers.loading && !providers.data ? (
            <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
              <Spinner /> 加载供应商…
            </div>
          ) : (providers.data?.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-zinc-500">还没有供应商。新建后可先点「模型」添加或拉取模型，最后点「测试调用」验证连通。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                    <th className="px-4 py-2 font-normal">名称</th>
                    <th className="px-4 py-2 font-normal">协议</th>
                    <th className="px-4 py-2 font-normal">Base URL</th>
                    <th className="px-4 py-2 font-normal">模型数</th>
                    <th className="px-4 py-2 font-normal">密钥</th>
                    <th className="px-4 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(providers.data ?? []).map((provider) => (
                    <tr key={provider.id} className="border-b border-zinc-50 last:border-0">
                      <td className="px-4 py-2 font-medium">{provider.name}</td>
                      <td className="px-4 py-2">
                        <Badge>{PROTOCOL_LABEL[provider.protocol]}</Badge>
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-xs text-zinc-500" title={provider.baseUrl}>
                        {provider.baseUrl}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-600">{provider.models.length}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-zinc-400">{provider.apiKey}</td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-0.5">
                          <Button variant="ghost" onClick={() => openForm(provider)}>
                            编辑
                          </Button>
                          <Button variant="ghost" onClick={() => setModelTargetId(provider.id)}>
                            模型
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={testingId === provider.id}
                            onClick={() => void runTest(provider)}
                          >
                            {testingId === provider.id ? '测试中…' : '测试调用'}
                          </Button>
                          <Button
                            variant="ghost"
                            className="text-red-600"
                            onClick={() => void removeProvider(provider)}
                          >
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <SeedreamCard />

      <Dialog
        open={form !== null}
        title={form?.id ? '编辑供应商' : '新建供应商'}
        description="密钥只写不读；留空表示保持原密钥不变"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button type="submit" form="provider-form" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {form ? (
          <form id="provider-form" className="space-y-3" onSubmit={(event) => void submitForm(event)}>
            <Field label="名称">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="例如：OpenAI 官方"
                autoFocus
              />
            </Field>
            <Field
              label="协议"
              hint="OpenAI Responses API：请求 /responses；Anthropic Messages API：请求 /v1/messages"
            >
              <Select
                value={form.protocol}
                onChange={(value) => setForm({ ...form, protocol: value as Protocol })}
                options={[
                  { value: 'openai', label: PROTOCOL_LABEL.openai },
                  { value: 'anthropic', label: PROTOCOL_LABEL.anthropic },
                ]}
              />
            </Field>
            <Field
              label="Base URL"
              hint="OpenAI Responses API：Base URL 需包含 /v1，请求会发往 /v1/responses；Anthropic Messages API：填域名即可，程序自动补 /v1/messages"
            >
              <Input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder={form.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
              />
            </Field>
            <Field label="API Key" hint={form.id ? '留空则沿用原密钥' : '新建必填'}>
              <Input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={form.id ? '留空不修改' : 'sk-…'}
                autoComplete="off"
              />
            </Field>
            <InlineError message={formError} />
            <InlineHint>密钥落在应用配置目录（chmod 0600），不会写入存储目录，也不会落 pi 的 auth.json。</InlineHint>
          </form>
        ) : null}
      </Dialog>

      {modelTarget ? (
        <ModelsDialog
          provider={modelTarget}
          onClose={() => setModelTargetId(null)}
          onChanged={async () => {
            await Promise.all([providers.reload(), settings.reload()]);
          }}
        />
      ) : null}
    </div>
  );
}
