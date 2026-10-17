'use client';
import { useState } from 'react';
import type { McpProbeResult, McpServer } from '@aidocs/contracts';
import { findMcpLauncher, MCP_LAUNCHER_PRESETS } from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, CardHeader, Input, Textarea } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { McpImportDialog } from './mcp-import-dialog';
import { Dialog, Field, InlineError, InlineHint, Select, Spinner, Toggle } from './primitives';
import { useToast } from './toast';

interface McpForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  enabled: boolean;
}

const EMPTY_FORM: McpForm = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  enabled: true,
};

type ProbeCell = { state: 'untested' } | { state: 'probing' } | McpProbeResult;

export function McpTab() {
  const toast = useToast();
  const servers = useLoader(api.listMcp);
  const [form, setForm] = useState<McpForm | null>(null);
  const [formError, setFormError] = useState('');
  const [formProbe, setFormProbe] = useState<ProbeCell>({ state: 'untested' });
  const [probingForm, setProbingForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeCell>>({});
  const [importOpen, setImportOpen] = useState(false);

  function openForm(server?: McpServer) {
    setFormError('');
    setFormProbe({ state: 'untested' });
    if (!server) {
      setForm({ ...EMPTY_FORM });
      return;
    }
    setForm({
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      argsText: server.args.join('\n'),
      envText: pairsToText(server.env),
      url: server.url ?? '',
      headersText: pairsToText(server.headers),
      enabled: server.enabled,
    });
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    if (!form.name.trim()) {
      setFormError('名称不能为空');
      return;
    }
    let server: McpServer;
    try {
      server = formToServer(form);
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.saveMcp(server);
      toast.success('MCP 配置已保存');
      setForm(null);
      await servers.reload();
    } catch (error) {
      setFormError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function probeForm() {
    if (!form) return;
    let server: McpServer;
    try {
      server = formToServer(form);
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }
    setProbingForm(true);
    setFormError('');
    try {
      const result = await api.probeMcp({ server });
      setFormProbe(result);
      if (result.state === 'ok') toast.success('连接成功');
      else toast.error(`连接失败：${result.reason}`);
    } catch (error) {
      setFormProbe({ state: 'error', toolCount: null, reason: errorMessage(error), checkedAt: new Date().toISOString() });
      toast.error(errorMessage(error));
    } finally {
      setProbingForm(false);
    }
  }

  async function probeRow(server: McpServer) {
    setProbes((prev) => ({ ...prev, [server.name]: { state: 'probing' } }));
    try {
      const result = await api.probeMcp({ name: server.name });
      setProbes((prev) => ({ ...prev, [server.name]: result }));
      if (result.state === 'ok') toast.success(`${server.name} 连接成功`);
      else toast.error(`${server.name} 连接失败：${result.reason}`);
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [server.name]: {
          state: 'error',
          toolCount: null,
          reason: errorMessage(error),
          checkedAt: new Date().toISOString(),
        },
      }));
      toast.error(errorMessage(error));
    }
  }

  async function removeServer(server: McpServer) {
    if (!window.confirm(`删除 MCP 配置「${server.name}」？`)) return;
    try {
      await api.deleteMcp(server.name);
      toast.success('MCP 配置已删除');
      await servers.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function refreshAfterImport(): Promise<void> {
    await servers.reload();
  }

  /** 当前命令对应的启动器：表单里用它给示例参数、安装提示；不是启动器就是 null */
  const formLauncher = form && form.transport === 'stdio' ? findMcpLauncher(form.command) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">MCP 服务器（全局）</div>
            <div className="text-[11px] text-zinc-400">
              按类型勾选后注入；探针：stdio 查命令、http 发 initialize；粘贴导入认多种客户端方言
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setImportOpen(true)}
              disabled={servers.loading || servers.data === null}
            >
              粘贴 JSON 导入
            </Button>
            <Button onClick={() => openForm()}>
              新建 MCP
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <InlineError message={servers.error} />
          {servers.loading && !servers.data ? (
            <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
              <Spinner /> 加载 MCP 配置…
            </div>
          ) : (servers.data?.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-zinc-500">
              还没有 MCP 配置。可新建 stdio（本地命令）或 http（远端 URL），也可以粘贴 Claude / VS Code 等客户端的 JSON 批量导入。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                    <th className="px-4 py-2 font-normal">名称</th>
                    <th className="px-4 py-2 font-normal">传输</th>
                    <th className="px-4 py-2 font-normal">命令或 URL</th>
                    <th className="px-4 py-2 font-normal">状态</th>
                    <th className="px-4 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(servers.data ?? []).map((server) => {
                    const probe = probes[server.name] ?? { state: 'untested' as const };
                    return (
                      <tr key={server.name} className="border-b border-zinc-50 align-top last:border-0">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{server.name}</span>
                            {!server.enabled ? <Badge>已停用</Badge> : null}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <Badge>{server.transport}</Badge>
                        </td>
                        <td className="max-w-[280px] px-4 py-2">
                          <div className="truncate font-mono text-[11px] text-zinc-600" title={server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}>
                            {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <ProbeBadge probe={probe} />
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              disabled={probe.state === 'probing'}
                              onClick={() => void probeRow(server)}
                            >
                              {probe.state === 'probing' ? '测试中…' : '测试连接'}
                            </Button>
                            <Button variant="ghost" onClick={() => openForm(server)}>
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              className="text-red-600"
                              onClick={() => void removeServer(server)}
                            >
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={form !== null}
        title={form?.name ? `编辑 MCP · ${form.name}` : '新建 MCP'}
        description="stdio 只填命令与参数；http 填 URL 与请求头"
        onClose={() => setForm(null)}
        wide
        footer={
          <>
            <Button variant="outline" onClick={() => void probeForm()} disabled={probingForm}>
              {probingForm ? '测试中…' : '测试连接'}
            </Button>
            <Button variant="outline" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button type="submit" form="mcp-form" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {form ? (
          <form id="mcp-form" className="space-y-3" onSubmit={(event) => void submitForm(event)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="名称" hint="唯一标识，导入时按名称覆盖">
                <Input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="context7"
                  autoFocus
                />
              </Field>
              <Field label="传输">
                <Select
                  value={form.transport}
                  onChange={(value) => setForm({ ...form, transport: value as 'stdio' | 'http' })}
                  options={[
                    { value: 'stdio', label: 'stdio（本地命令）' },
                    { value: 'http', label: 'http（远端 URL）' },
                  ]}
                />
              </Field>
            </div>

            {form.transport === 'stdio' ? (
              <>
                <Field
                  label="命令"
                  hint="PATH 里的名字，或绝对路径；npx / uvx 这类启动器还会在 ~/.local/bin、/opt/homebrew/bin 等常见目录里再找一次"
                >
                  <Input
                    value={form.command}
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                    placeholder="npx"
                    className="font-mono text-xs"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-zinc-400">常用启动器</span>
                  {MCP_LAUNCHER_PRESETS.map((preset) => (
                    <Button
                      key={preset.bin}
                      type="button"
                      variant={formLauncher?.bin === preset.bin ? 'default' : 'outline'}
                      onClick={() =>
                        setForm({
                          ...form,
                          command: preset.bin,
                          // 空着才填示例；已经有参数说明用户在写自己的，不覆盖
                          argsText:
                            form.argsText.trim() === '' ? preset.exampleArgs.join('\n') : form.argsText,
                        })
                      }
                    >
                      {preset.bin}
                    </Button>
                  ))}
                </div>
                {formLauncher ? (
                  <p className="text-[11px] text-zinc-500">
                    {formLauncher.bin} · {formLauncher.label}
                    {formLauncher.downloads ? '，首次运行会现下载包' : ''}；{formLauncher.install}
                  </p>
                ) : null}
                <Field label="参数（每行一个）">
                  <Textarea
                    rows={3}
                    value={form.argsText}
                    onChange={(event) => setForm({ ...form, argsText: event.target.value })}
                    placeholder={formLauncher?.exampleArgs.join('\n') ?? '-y\n@upstash/context7-mcp'}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="环境变量（每行 KEY=VALUE）">
                  <Textarea
                    rows={2}
                    value={form.envText}
                    onChange={(event) => setForm({ ...form, envText: event.target.value })}
                    placeholder="API_KEY=xxx"
                    className="font-mono text-xs"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <Input
                    value={form.url}
                    onChange={(event) => setForm({ ...form, url: event.target.value })}
                    placeholder="https://example.com/mcp"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="请求头（每行 KEY=VALUE）">
                  <Textarea
                    rows={2}
                    value={form.headersText}
                    onChange={(event) => setForm({ ...form, headersText: event.target.value })}
                    placeholder="Authorization=Bearer xxx"
                    className="font-mono text-xs"
                  />
                </Field>
              </>
            )}

            <div className="flex items-center gap-3">
              <Toggle checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} label="启用" />
              <span className="text-xs text-zinc-600">{form.enabled ? '启用（可被类型勾选注入）' : '全局停用（类型勾选也不会注入）'}</span>
            </div>

            <InlineError message={formError} />
            {formProbe.state !== 'untested' ? (
              <div className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs">
                <ProbeBadge probe={formProbe} />
              </div>
            ) : null}
            <InlineHint>
              stdio 探针只做命令可执行性检查（PATH + ~/.local/bin、/opt/homebrew/bin 等常见目录），不启动进程；真实 MCP
              initialize 在会话启动时由 pi-mcp 完成，起进程时这些目录也会补进 PATH。
            </InlineHint>
          </form>
        ) : null}
      </Dialog>

      <McpImportDialog
        open={importOpen}
        servers={servers.data ?? []}
        onClose={() => setImportOpen(false)}
        onImported={refreshAfterImport}
      />
    </div>
  );
}

function ProbeBadge({ probe }: { probe: ProbeCell }) {
  if (probe.state === 'untested') return <Badge>未测</Badge>;
  if (probe.state === 'probing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
        <Spinner /> 连接中
      </span>
    );
  }
  if (probe.state === 'ok') {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <Badge className="bg-emerald-50 text-emerald-700">
          成功{probe.toolCount != null ? ` · ${probe.toolCount} 个工具` : ''}
        </Badge>
        {probe.reason ? <span className="max-w-[260px] truncate text-[11px] text-zinc-400" title={probe.reason}>{probe.reason}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <Badge className="bg-red-50 text-red-700">失败</Badge>
      <span className="max-w-[260px] truncate text-[11px] text-red-500" title={probe.reason}>
        {probe.reason}
      </span>
    </span>
  );
}

function pairsToText(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`无法解析环境变量/请求头行：${trimmed}（应为 KEY=VALUE）`);
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function formToServer(form: McpForm): McpServer {
  const base = {
    name: form.name.trim(),
    transport: form.transport,
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    enabled: form.enabled,
  };
  if (form.transport === 'stdio') {
    if (!form.command.trim()) throw new Error('stdio 必须填写 command');
    return {
      ...base,
      command: form.command.trim(),
      args: form.argsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      env: parsePairs(form.envText),
    };
  }
  if (!form.url.trim()) throw new Error('http 必须填写 URL');
  return {
    ...base,
    command: undefined,
    url: form.url.trim(),
    headers: parsePairs(form.headersText),
  };
}
