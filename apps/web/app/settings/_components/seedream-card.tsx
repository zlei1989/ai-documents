'use client';
import { useEffect, useRef, useState } from 'react';
import {
  SEEDREAM_DEFAULT_BASE_URL,
  SEEDREAM_DEFAULT_MODEL,
  SEEDREAM_DEFAULT_SIZE,
  SEEDREAM_MODEL_PRESETS,
  SEEDREAM_SIZE_PRESETS,
  type SeedreamTestResult,
} from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, CardHeader, Input } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { ComboBox, Field, InlineError, InlineHint, Spinner, Toggle } from './primitives';
import { useToast } from './toast';

/** 「默认模型」下拉预设；输入框仍可手填预设之外的模型 ID / Endpoint ID */
const MODEL_OPTIONS = SEEDREAM_MODEL_PRESETS.map((preset) => ({ value: preset.id, hint: preset.hint }));
/** 「默认尺寸」下拉预设；也可手填其它宽x高 */
const SIZE_OPTIONS = SEEDREAM_SIZE_PRESETS.map((preset) => ({ value: preset.id, hint: preset.hint }));

/**
 * 火山引擎（Seedream 生图）配置卡片：
 * - 启用 / Base URL / API Key / 默认模型 / 默认尺寸；
 * - key 只写不读；测试按钮同时验证 Ark 鉴权与 Files API 文件上传。
 */
export function SeedreamCard() {
  const toast = useToast();
  const state = useLoader(api.getSeedream);
  const initialized = useRef(false);

  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(SEEDREAM_DEFAULT_BASE_URL);
  const [model, setModel] = useState(SEEDREAM_DEFAULT_MODEL);
  const [size, setSize] = useState(SEEDREAM_DEFAULT_SIZE);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<SeedreamTestResult | null>(null);

  useEffect(() => {
    if (!state.data || initialized.current) return;
    initialized.current = true;
    setEnabled(state.data.enabled);
    setBaseUrl(state.data.baseUrl || SEEDREAM_DEFAULT_BASE_URL);
    setModel(state.data.model || SEEDREAM_DEFAULT_MODEL);
    setSize(state.data.size || SEEDREAM_DEFAULT_SIZE);
  }, [state.data]);

  async function save() {
    if (!baseUrl.trim()) {
      setError('Base URL 不能为空');
      return;
    }
    if (!model.trim()) {
      setError('默认模型不能为空');
      return;
    }
    if (!size.trim()) {
      setError('默认尺寸不能为空');
      return;
    }
    if (enabled && !state.data?.hasKey && !apiKey.trim()) {
      setError('启用前请填写 API Key');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.saveSeedream({
        enabled,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        size: size.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      setTestResult(null);
      toast.success(enabled ? '火山引擎已启用' : '火山引擎设置已保存');
      await state.reload();
    } catch (cause) {
      setError(errorMessage(cause));
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testSeedream());
    } catch (cause) {
      setTestResult({
        ok: false,
        arkOk: false,
        reason: errorMessage(cause),
        latencyMs: 0,
        model: model.trim() || SEEDREAM_DEFAULT_MODEL,
        files: null,
      });
    } finally {
      setTesting(false);
    }
  }

  const hasSavedKey = state.data?.hasKey ?? false;
  // Ark 探针与 Files API 上传都要 key
  const canTest = hasSavedKey && !saving;

  return (
    <Card>
      <CardHeader className="justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            火山引擎
            <Badge className={enabled ? 'bg-emerald-50 text-emerald-700' : ''}>{enabled ? '已启用' : '未启用'}</Badge>
          </div>
          <div className="text-[11px] text-zinc-400">
            Seedream 生图 · 参考图上传方舟 Files API（默认 1 天后过期）；一个工具覆盖文生图/图生图/融合/图层拆分/交互编辑/组图/流式/联网搜索
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <InlineError message={state.error} />
        {state.loading && !state.data ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Spinner /> 加载生图配置…
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={setEnabled} label="启用火山引擎生图" />
          <span className="text-xs text-zinc-600">
            {enabled ? '创作会话会注入 seedream_image_generation' : '关闭时模型看不到生图工具'}
          </span>
        </div>

        <Field label="Base URL" hint="默认 https://ark.cn-beijing.volces.com/api/v3；只填域名会自动补 /api/v3">
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={SEEDREAM_DEFAULT_BASE_URL}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="API Key"
          hint={
            hasSavedKey
              ? `已保存 ${state.data?.apiKey ?? ''}；留空不修改`
              : '只写不读；保存后落在 ~/.aidocs/config.json（0600）'
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={hasSavedKey ? '留空不修改' : 'ARK_API_KEY'}
            autoComplete="off"
          />
        </Field>

        <Field
          label="默认模型"
          hint="可下拉选预设，也可直接输入其它模型 ID / Endpoint ID；组图/流式/联网搜索需 5.0 lite/4.5/4.0"
        >
          <ComboBox
            value={model}
            onChange={setModel}
            options={MODEL_OPTIONS}
            placeholder={SEEDREAM_DEFAULT_MODEL}
            ariaLabel="默认模型"
          />
        </Field>

        <Field
          label="默认尺寸"
          hint="文生图默认尺寸：文章插图建议 3:2 1536×1024；图生图/编辑不传 size 时按模型默认。工具参数 size 可覆盖"
        >
          <ComboBox
            value={size}
            onChange={setSize}
            options={SIZE_OPTIONS}
            placeholder={SEEDREAM_DEFAULT_SIZE}
            ariaLabel="默认尺寸"
          />
        </Field>

        <InlineHint>
          本地参考图会先上传到方舟 Files API（复用本卡 Base URL/API Key），文件名 = 内容 SHA-256，默认 1 天后过期；上传成功后用返回的 File ID 作为参考图。上传失败（例如当前 Base URL 不支持 Files API）会自动回退 base64，不影响图生图/编辑。
        </InlineHint>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button variant="outline" onClick={() => void test()} disabled={testing || !canTest}>
            {testing ? '测试中…' : '测试连接与文件上传'}
          </Button>
          <span className="text-[11px] text-zinc-400">
            保存后下一轮自动重建会话（历史保留）；测试不生成图片、不计费，会在方舟 Files API 上传一个 1×1 测试文件，1 天后自动过期。
          </span>
        </div>

        {testResult ? (
          <div className="space-y-1 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs">
            <div className={testResult.arkOk ? 'text-emerald-700' : 'text-red-600'}>
              {testResult.arkOk ? '✓ ' : '✗ '}
              模型接口：{testResult.reason}
              {testResult.latencyMs > 0 ? `（${testResult.latencyMs} ms）` : ''}
            </div>
            {testResult.files ? (
              <div className={testResult.files.ok ? 'text-emerald-700' : 'text-red-600'}>
                {testResult.files.ok ? '✓ ' : '✗ '}
                文件上传：{testResult.files.reason}
                {testResult.files.latencyMs > 0 ? `（${testResult.files.latencyMs} ms）` : ''}
              </div>
            ) : (
              <div className="text-zinc-500">文件上传：未测试（需要先保存 API Key）</div>
            )}
          </div>
        ) : null}

        <InlineError message={error} />
      </CardContent>
    </Card>
  );
}
