'use client';
import { useMemo, useState } from 'react';
import {
  MCP_IMPORT_SHAPE_EXAMPLES,
  MCP_IMPORT_STYLE_LABELS,
  mcpImportNameIssue,
  parseMcpImport,
  type McpServer,
} from '@aidocs/contracts';
import { Badge, Button, Checkbox, Input, Textarea } from '@aidocs/ui';
import { api, type McpImportApiResult } from '../_lib/settings-api';
import { errorMessage } from '../_lib/use-loader';
import { Dialog, InlineError, InlineHint } from './primitives';
import { useToast } from './toast';

/**
 * 「粘贴 JSON」弹窗：贴进去 → **先看预览**（逐条说清将要发生什么）→ 确认才导入。
 *
 * 三个必须守住的点：
 *   1. **预览与落盘是同一份判定**：每一行的「新增 / 覆盖 / 跳过 / 不导入+原因」都来自
 *      `parseMcpImport`（契约里的纯函数），组件这一层不自己再判一次；
 *   2. **同名默认覆盖、逐行可切跳过**：每一行都有「跳过」开关；「先清空现有条目」默认关；
 *   3. **名字只有猜出来的那几行可改**：显式名字与 map 的键名都来自源配置，改了反而对不上。
 */
export function McpImportDialog({
  open,
  servers,
  onClose,
  onImported,
}: {
  open: boolean;
  servers: McpServer[];
  onClose: () => void;
  onImported: (result: McpImportApiResult) => void | Promise<void>;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});
  const [clearFirst, setClearFirst] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const parsed = useMemo(() => parseMcpImport(text, servers), [text, servers]);
  const existingByName = useMemo(() => new Map(servers.map((server) => [server.name, server])), [servers]);

  // 名字的唯一判据：先把「这一批里将要导入的那些名字」算出来，再让每一行排除自己
  const importable = parsed.entries
    .map((entry) => ({
      key: entry.name,
      name: decisions[entry.name]?.name ?? entry.name,
      skipped: decisions[entry.name]?.skipped ?? false,
    }))
    .filter((row) => !row.skipped);

  const issueOf = (key: string, name: string): string | null =>
    mcpImportNameIssue(name, importable.filter((row) => row.key !== key).map((row) => row.name));

  const rows: PreviewRow[] = [
    ...parsed.entries.map((entry): PreviewRow => {
      const decision = decisions[entry.name] ?? {};
      // 首尾空白在服务端会被 trim：预览的「覆盖 / 新增」必须按同一把尺子算
      const name = (decision.name ?? entry.name).trim();
      const skipped = decision.skipped ?? false;
      const blockedReason = skipped ? null : issueOf(entry.name, name);
      const overwrite = existingByName.has(name);
      const tone: ActionTone = skipped ? 'skip' : blockedReason !== null ? 'reject' : overwrite && !clearFirst ? 'overwrite' : 'add';
      const actionText =
        skipped ? '跳过' : blockedReason !== null ? '不导入' : overwrite && !clearFirst ? `覆盖已有 ${name}` : '新增';
      return {
        key: `entry:${entry.name}`,
        kind: 'entry',
        name,
        originalName: entry.name,
        transport: entry.server.transport,
        endpoint: endpointOf(entry.server),
        server: { ...entry.server, name },
        droppedFields: entry.droppedFields,
        notes: entry.notes,
        skipped,
        blockedReason,
        actionText,
        tone,
        renamable: entry.renamable,
        nameGuessed: entry.nameGuessed,
        ...(entry.existing === undefined ? {} : { existing: entry.existing }),
      };
    }),
    ...parsed.rejected.map(
      (item, index): PreviewRow => ({
        key: `rejected:${index}:${item.name}`,
        kind: 'rejected',
        name: item.name,
        originalName: item.name,
        ...(item.transport === undefined ? {} : { transport: item.transport }),
        endpoint: '',
        droppedFields: item.droppedFields,
        notes: item.notes,
        skipped: false,
        blockedReason: item.reason,
        actionText: '不导入',
        tone: 'reject',
        renamable: false,
        nameGuessed: false,
      }),
    ),
  ];

  // 将要写入的那些行：没被跳过、也没有名字问题。计数与落盘用的是**同一个**数组
  const selected = rows
    .filter((row): row is PreviewRow & { server: McpServer } => row.kind === 'entry' && row.server !== undefined)
    .filter((row) => !row.skipped && row.blockedReason === null)
    .map((row) => ({ ...row.server, name: row.name }));
  const overwriteCount = clearFirst ? 0 : selected.filter((server) => existingByName.has(server.name)).length;
  const showParseError = text.trim() !== '' && parsed.error !== undefined;
  const canImport = text.trim() !== '' && parsed.error === undefined && selected.length > 0 && !importing;

  function patchDecision(key: string, patch: RowDecision): void {
    setDecisions((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ...patch } }));
  }

  function changeText(value: string): void {
    setText(value);
    // 文本一换，上一批的「跳过 / 改名」决定就不该继续生效
    setDecisions({});
    setError('');
  }

  function reset(): void {
    setText('');
    setDecisions({});
    setClearFirst(false);
    setError('');
  }

  function handleClose(): void {
    if (importing) return;
    reset();
    onClose();
  }

  async function confirm(): Promise<void> {
    if (!canImport) return;
    setImporting(true);
    setError('');
    try {
      const result = await api.importMcp(selected, { clear: clearFirst });
      toast.success(`已导入 ${result.imported} 台 MCP 配置${overwriteCount > 0 ? `，覆盖 ${overwriteCount} 台` : ''}`);
      reset();
      onClose();
      void onImported(result);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="粘贴 JSON 导入"
      description="认多种 MCP 配置方言；先看预览，确认后才写入"
      onClose={handleClose}
      wide
      footer={
        <>
          <Button variant="outline" onClick={handleClose} disabled={importing}>
            取消
          </Button>
          <Button onClick={() => void confirm()} disabled={!canImport}>
            {importing ? '导入中…' : `导入 ${selected.length} 台${overwriteCount > 0 ? `（覆盖 ${overwriteCount}）` : ''}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-zinc-400">填入示例：</span>
          {MCP_IMPORT_SHAPE_EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => changeText(example.text)}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-50"
            >
              {example.label}
            </button>
          ))}
        </div>

        <Textarea
          rows={8}
          value={text}
          aria-label="粘贴内容"
          onChange={(event) => changeText(event.target.value)}
          placeholder={'支持 { "mcpServers": … }、{ "servers": … }（VS Code）、单台服务器、数组与 JSONC…'}
          className="font-mono text-xs"
        />

        <div className="flex flex-wrap items-center gap-2">
          <InlineHint>
            认 Claude Desktop / Cursor / Windsurf / Cline / VS Code / Continue / Zed / OpenCode / Gemini CLI / 本应用数组；
            注释与尾逗号也认。上限 256 KB / 100 条。
          </InlineHint>
        </div>

        {parsed.style !== undefined && parsed.error === undefined ? (
          <Badge className="bg-sky-50 text-sky-700">识别为：{MCP_IMPORT_STYLE_LABELS[parsed.style]}</Badge>
        ) : null}

        {showParseError ? (
          <div className="space-y-1 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            <div className="font-medium">认不出这段内容</div>
            <div>{parsed.error?.message}</div>
            {parsed.error?.topLevelKeys !== undefined ? (
              <div className="pt-1 text-red-500">
                能贴的形状：{MCP_IMPORT_SHAPE_EXAMPLES.slice(0, 4).map((example) => example.label).join(' / ')}；
                也可以直接点上面的示例。
              </div>
            ) : null}
          </div>
        ) : null}

        {parsed.droppedFields.length > 0 ? (
          <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            整份丢掉了这些字段：{parsed.droppedFields.join('、')}
            <span className="text-amber-600">（它们是信封自己的字段，如 VS Code 的 inputs，不会写进 MCP 配置）</span>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="max-h-[320px] overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="sticky top-0 z-10 bg-white text-left text-xs text-zinc-500">
                <tr className="border-b border-zinc-100">
                  <th className="px-3 py-2 font-normal">名称</th>
                  <th className="px-3 py-2 font-normal">传输</th>
                  <th className="px-3 py-2 font-normal">端点或命令</th>
                  <th className="px-3 py-2 font-normal">处置</th>
                  <th className="px-3 py-2 font-normal">被丢字段 / 备注</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-zinc-50 align-top last:border-0">
                    <td className="px-3 py-2">
                      <div className="flex min-w-[160px] items-center gap-1">
                        {row.kind === 'entry' && row.renamable ? (
                          <Input
                            value={row.name}
                            aria-label={`名称 ${row.originalName}`}
                            onChange={(event) => patchDecision(row.originalName, { name: event.target.value.trim() })}
                            className="h-7 font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono text-xs text-zinc-800">{row.name}</span>
                        )}
                        {row.nameGuessed ? <span className="shrink-0 text-[10px] text-zinc-400">可改</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {row.transport === undefined ? (
                        <span className="text-xs text-zinc-400">—</span>
                      ) : (
                        <Badge className={row.transport === 'http' ? 'bg-blue-50 text-blue-700' : 'bg-violet-50 text-violet-700'}>
                          {row.transport}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-[260px] truncate font-mono text-[11px] text-zinc-600" title={row.endpoint}>
                        {row.endpoint || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] ${TONE_CLASS[row.tone]}`}
                            title={
                              row.existing === undefined
                                ? undefined
                                : `当前已有：${row.existing.transport} · ${endpointOf(row.existing)}`
                            }
                          >
                            {row.actionText}
                          </span>
                          {row.kind === 'entry' ? (
                            <label className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                              <Checkbox
                                checked={row.skipped}
                                aria-label={`跳过 ${row.name}`}
                                onChange={(event) => patchDecision(row.originalName, { skipped: event.target.checked })}
                              />
                              跳过
                            </label>
                          ) : null}
                        </div>
                        {row.blockedReason !== null ? (
                          <span className="max-w-[300px] text-[11px] text-red-600">{row.blockedReason}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <DroppedCell dropped={row.droppedFields} notes={row.notes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {servers.length > 0 && rows.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-zinc-600">
            <Checkbox checked={clearFirst} onChange={(event) => setClearFirst(event.target.checked)} />
            先清空现有条目再导入（会删掉现有 {servers.length} 台）
          </label>
        ) : null}

        <InlineError message={error} />
      </div>
    </Dialog>
  );
}

interface RowDecision {
  skipped?: boolean;
  name?: string;
}

type ActionTone = 'add' | 'overwrite' | 'skip' | 'reject';

interface PreviewRow {
  key: string;
  kind: 'entry' | 'rejected';
  name: string;
  originalName: string;
  transport?: McpServer['transport'];
  endpoint: string;
  server?: McpServer;
  droppedFields: string[];
  notes: string[];
  skipped: boolean;
  blockedReason: string | null;
  actionText: string;
  tone: ActionTone;
  renamable: boolean;
  nameGuessed: boolean;
  existing?: McpServer;
}

const TONE_CLASS: Record<ActionTone, string> = {
  add: 'bg-emerald-50 text-emerald-700',
  overwrite: 'bg-amber-50 text-amber-700',
  skip: 'bg-zinc-100 text-zinc-500',
  reject: 'bg-red-50 text-red-700',
};

function endpointOf(server: McpServer): string {
  return server.transport === 'http' ? server.url ?? '' : [server.command, ...server.args].filter(Boolean).join(' ');
}

function DroppedCell({ dropped, notes }: { dropped: string[]; notes: string[] }) {
  const parts = [...dropped, ...notes];
  if (parts.length === 0) return <span className="text-xs text-zinc-400">—</span>;
  return (
    <div className="max-w-[240px] text-[11px] leading-relaxed text-zinc-500" title={parts.join('；')}>
      <span className="line-clamp-2">{parts.join('、')}</span>
    </div>
  );
}
