'use client';
import { useEffect, useRef, useState } from 'react';
import type { ProviderView, ResearchSourceInfo, ResearchTestResult } from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, CardHeader, Input } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { Field, InlineError, InlineHint, Select, Spinner, Toggle } from './primitives';
import { useToast } from './toast';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

interface Loaded {
  response: Awaited<ReturnType<typeof api.getSettings>>;
  providers: ProviderView[];
  sources: ResearchSourceInfo[];
}

function looksDeepseek(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('deepseek.com');
  } catch {
    return false;
  }
}

/**
 * 资料查询（DeepSeek Search/Fetch）：
 * 默认注入，没有启用开关；key 不在这里存 —— 只借用所选「模型供应商」的 API Key，接口地址可单独覆盖。
 */
export function ResearchTab() {
  const toast = useToast();
  const state = useLoader<Loaded>(async () => {
    const [response, providers, sources] = await Promise.all([
      api.getSettings(),
      api.listProviders(),
      api.listResearchSources(),
    ]);
    return { response, providers, sources };
  });
  const initialized = useRef(false);

  const [providerId, setProviderId] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [count, setCount] = useState('8');
  const [needContent, setNeedContent] = useState(false);
  const [disabledSources, setDisabledSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ResearchTestResult | null>(null);

  useEffect(() => {
    if (!state.data || initialized.current) return;
    initialized.current = true;
    const research = state.data.response.settings.research;
    setProviderId(research.providerId ?? '');
    setBaseUrl(research.baseUrl || DEFAULT_BASE_URL);
    setCount(String(research.count));
    setNeedContent(research.needContent);
    setDisabledSources(research.disabledSources ?? []);
  }, [state.data]);

  const providers = state.data?.providers ?? [];
  const sources = state.data?.sources ?? [];
  const enabledCount = sources.filter((source) => source.always || !disabledSources.includes(source.id)).length;
  const selected = providers.find((item) => item.id === providerId);
  const autoPick = providers.find((item) => looksDeepseek(item.baseUrl));
  const effectiveProvider = selected ?? (providerId ? undefined : autoPick);
  const effectiveBaseUrl = baseUrl.trim() || DEFAULT_BASE_URL;

  function toggleSource(id: string, on: boolean) {
    setDisabledSources((prev) => (on ? prev.filter((item) => item !== id) : [...new Set([...prev, id])]));
  }

  async function save() {
    const parsed = Number(count);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
      setSaveError('默认条数必须是 1–50 的整数');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await api.updateSettings({
        research: {
          providerId: providerId || null,
          baseUrl: effectiveBaseUrl,
          count: Math.round(parsed),
          needContent,
          disabledSources,
        },
      });
      toast.success('资料查询设置已保存');
      await state.reload();
    } catch (error) {
      setSaveError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testResearch({ baseUrl: effectiveBaseUrl, providerId: providerId || null });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, reason: errorMessage(error), latencyMs: 0, sample: null });
    } finally {
      setTesting(false);
    }
  }

  if (state.loading && !state.data) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Spinner /> 加载资料查询设置…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <InlineError message={state.error} />

      <Card>
        <CardHeader>
          <div>
            <div className="text-sm font-medium">API Key 来源与接口地址</div>
            <div className="text-[11px] text-zinc-400">
              资料查询默认注入：配置可用时创作会话始终带 research_search / research_fetch / research_save；key 只借用供应商，不在这里再存一份
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            label="供应商（提供 DeepSeek API Key）"
            hint="资料查询用同一把 DeepSeek key；选一条 DeepSeek 供应商即可"
          >
            <Select
              value={providerId}
              onChange={setProviderId}
              options={[
                { value: '', label: autoPick ? `自动：${autoPick.name}` : '自动（当前没有指向 deepseek.com 的供应商）' },
                ...providers.map((item) => ({
                  value: item.id,
                  label: `${item.name}${looksDeepseek(item.baseUrl) ? ' · DeepSeek' : ''} · ${item.apiKey}`,
                })),
              ]}
            />
          </Field>

          {effectiveProvider ? (
            <p className="text-[11px] text-zinc-400">
              当前用「{effectiveProvider.name}」的 key <span className="font-mono">{effectiveProvider.apiKey}</span>
              {looksDeepseek(effectiveProvider.baseUrl) ? '' : '（⚠️ 这条供应商不像 DeepSeek 官方，key 可能不被 tools 接口接受）'}
            </p>
          ) : (
            <p className="text-[11px] text-amber-600">
              还没有可用的 DeepSeek 供应商：先到「模型供应商」添加一条 Base URL 为 https://api.deepseek.com 的供应商。
            </p>
          )}

          <Field label="接口地址（Base URL）" hint="默认 DeepSeek 官方；同协议网关可改这里。已带 /v1 不会再重复补">
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_BASE_URL}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void test()} disabled={testing || !effectiveProvider}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            {testResult ? (
              <span className={testResult.ok ? 'text-xs text-emerald-700' : 'text-xs text-red-600'}>
                {testResult.ok ? '✓ ' : '✗ '}
                {testResult.reason}
                {testResult.latencyMs > 0 ? `（${testResult.latencyMs} ms）` : ''}
              </span>
            ) : (
              <span className="text-[11px] text-zinc-400">测试会真发一次 Search 请求</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">数据源</div>
            <div className="text-[11px] text-zinc-400">按内容类型选源；DeepSeek 联网搜索每次都会查</div>
          </div>
          <Badge className={enabledCount > 0 ? 'bg-emerald-50 text-emerald-700' : ''}>
            {enabledCount}/{sources.length} 已启用
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          {sources.length === 0 ? <p className="text-xs text-zinc-400">没有可用的数据源。</p> : null}
          {sources.map((source) => {
            const on = source.always || !disabledSources.includes(source.id);
            return (
              <div key={source.id} className="flex items-start gap-3 rounded-md border border-zinc-100 px-3 py-2">
                <span className="pt-0.5">
                  <Toggle
                    checked={on}
                    disabled={source.always}
                    onChange={(next) => toggleSource(source.id, next)}
                    label={source.label}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{source.label}</span>
                    <span className="font-mono text-[11px] text-zinc-400">{source.id}</span>
                    {source.always ? <Badge className="bg-zinc-900 text-white">必查</Badge> : null}
                    {source.needsKey ? <Badge className="bg-amber-50 text-amber-700">需 key</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{source.routing}</div>
                </div>
              </div>
            );
          })}
          <InlineHint>
            数据源都是公开 API：web 走 DeepSeek（按成功请求计费），其余是 Crossref / OpenAlex / Europe PMC / PubMed /
            DOAJ / arXiv / Gutenberg / GBIF / ClinicalTrials / 世界银行 / Eurostat 的免费开放接口。停用后模型看不到该源。
          </InlineHint>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <div className="text-sm font-medium">检索默认值</div>
            <div className="text-[11px] text-zinc-400">模型没显式传参时用这里的值</div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="默认返回条数" hint="1–50；只影响返回条数，不影响计费">
              <Input
                type="number"
                min={1}
                max={50}
                step={1}
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            </Field>
            <Field label="默认返回网页正文" hint="正文很大，建议关闭；取正文用 research_fetch">
              <div className="flex h-8 items-center gap-2">
                <Toggle checked={needContent} onChange={setNeedContent} label="默认返回正文" />
                <span className="text-xs text-zinc-500">{needContent ? '开（search 结果带正文）' : '关（只给摘要）'}</span>
              </div>
            </Field>
          </div>
          <InlineError message={saveError} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-400">保存后会重建进行中的创作会话（历史消息保留），下一轮生效。</span>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存资料查询设置'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
