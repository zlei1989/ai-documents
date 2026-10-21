'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitMerge, RefreshCw, Sparkles } from 'lucide-react';
import type { GitStatus, GitSyncAction, GitSyncCommit, RepairEventRecord, RepairStatus } from '@aidocs/contracts';
import { cn, Button } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage } from '../_lib/use-loader';
import { Drawer, InlineError, Spinner } from './primitives';
import { useToast } from './toast';

/**
 * 设置 → 存储 → 版本历史里的远端同步区。
 * 拉取/推送是显式操作；拉取出冲突时服务端会自动起一个 pi 修复任务，
 * 这里只负责把任务事件流展示出来，并在结束后刷新 git 状态。
 */
export function GitSyncSection({ git, onChanged }: { git: GitStatus; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<GitSyncAction | 'refresh' | 'repair' | null>(null);
  const [error, setError] = useState('');
  const [repairId, setRepairId] = useState<string | null>(null);
  const [repairFiles, setRepairFiles] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [repairRunning, setRepairRunning] = useState(false);
  const [lastCommits, setLastCommits] = useState<GitSyncCommit[]>([]);

  const conflicted = git.conflicted;
  const hasConflict = conflicted.length > 0 || git.merging;
  const hasRemote = Boolean(git.remote.name);

  async function refresh(): Promise<void> {
    setBusy('refresh');
    try {
      await onChanged();
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function sync(action: GitSyncAction): Promise<void> {
    setBusy(action);
    setError('');
    setLastCommits([]);
    try {
      const result = await api.syncStorage(action);
      await onChanged();
      setLastCommits(result.commits ?? []);
      if (result.reason === 'conflict') {
        setRepairFiles(result.files);
        if (result.repairId) {
          setRepairId(result.repairId);
          setRepairRunning(true);
          setDrawerOpen(true);
          toast.success(result.message);
        } else {
          setError(result.message);
          toast.error(result.message);
        }
        return;
      }
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        return;
      }
      toast.success(
        result.commits.length > 0
          ? `${result.message}；推送前按 ${result.commits.length} 个文件夹提交`
          : result.message,
      );
    } catch (cause) {
      setError(errorMessage(cause));
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function startRepair(): Promise<void> {
    setBusy('repair');
    setError('');
    try {
      const started = await api.startRepair();
      if (started.committed) {
        toast.success(started.sha ? `合并已提交（${started.sha}）` : '合并已提交');
        await onChanged();
        return;
      }
      setRepairId(started.id);
      setRepairFiles(started.files);
      setRepairRunning(true);
      setDrawerOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function abortMerge(): Promise<void> {
    if (!window.confirm('放弃本次合并？工作区会回到拉取前的状态，已解决的内容会丢失。')) return;
    setBusy('repair');
    setError('');
    try {
      await api.abortMerge();
      setRepairId(null);
      setRepairFiles([]);
      setRepairRunning(false);
      setDrawerOpen(false);
      toast.success('已放弃本次合并');
      await onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  function onRepairFinished(): void {
    setRepairRunning(false);
    void onChanged().catch((cause: unknown) => setError(errorMessage(cause)));
  }

  return (
    <div className="space-y-3 border-t border-zinc-100 pt-3">
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-xs text-zinc-500">远端</dt>
        <dd className="min-w-0 text-xs">
          {hasRemote ? (
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-zinc-600">{git.remote.name}</span>
              <span className="truncate font-mono text-[11px] text-zinc-400">{git.remote.url ?? '（未配置地址）'}</span>
            </span>
          ) : (
            <span className="text-zinc-500">未配置远端</span>
          )}
        </dd>
        <dt className="text-xs text-zinc-500">同步</dt>
        <dd className="flex flex-wrap items-center gap-2 text-xs">
          {hasRemote ? (
            git.remote.upstream ? (
              <>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600">
                  ↑{git.remote.ahead} ↓{git.remote.behind}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {git.remote.behind > 0 ? '远端有新提交，先拉取' : git.remote.ahead > 0 ? '有本地提交待推送' : '与远端一致'}
                </span>
              </>
            ) : (
              <span className="text-[11px] text-zinc-400">本地还没有远端分支引用；拉取一次后显示领先/落后</span>
            )
          ) : (
            <span className="text-[11px] text-zinc-400">在终端执行 git remote add origin &lt;url&gt; 后即可拉取/推送</span>
          )}
        </dd>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-zinc-400">
          {hasConflict ? '先解决冲突，再推送' : '推送前会按文件夹提交未提交改动；拉取冲突交给 pi'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={busy !== null}
            title="重新读取 git 状态（不发网络请求）"
          >
            {busy === 'refresh' ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
          <Button
            variant="outline"
            onClick={() => void sync('pull')}
            disabled={busy !== null || !hasRemote || hasConflict}
            title={hasConflict ? '先解决当前冲突' : 'git fetch + merge'}
          >
            {busy === 'pull' ? <Spinner /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
            拉取
          </Button>
          <Button
            onClick={() => void sync('push')}
            disabled={busy !== null || !hasRemote || hasConflict}
            title={hasConflict ? '先解决当前冲突' : '先按文件夹提交未提交改动，再 git push'}
          >
            {busy === 'push' ? <Spinner /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
            推送
          </Button>
        </div>
      </div>

      <InlineError message={error} />

      {lastCommits.length > 0 ? (
        <div className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2">
          <div className="text-[11px] font-medium text-zinc-600">推送前按文件夹提交</div>
          <ul className="mt-1 space-y-0.5">
            {lastCommits.map((commit) => (
              <li key={commit.path} className="flex items-baseline gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-700" title={commit.path}>
                  {commit.label}
                </span>
                <span className="shrink-0 font-mono text-zinc-400">{commit.sha}</span>
                <span className="shrink-0 text-zinc-400">{commit.files} 个文件</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasConflict ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                {conflicted.length > 0 ? `${conflicted.length} 个文件有冲突` : '合并尚未完成'}
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-amber-700">
                {conflicted.length === 0
                  ? '冲突标记已清空，还差一个合并提交；点「完成合并」即可。'
                  : 'pi 会读取冲突标记、合并双方内容；修完自动暂存并提交合并，再点「推送」即可。'}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                onClick={() => void startRepair()}
                disabled={busy !== null || (conflicted.length === 0 && repairRunning)}
              >
                {busy === 'repair' ? (
                  <Spinner />
                ) : conflicted.length === 0 ? (
                  <GitMerge className="h-3.5 w-3.5" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {conflicted.length === 0
                  ? '完成合并'
                  : repairRunning
                    ? '查看 pi 修复'
                    : repairId
                      ? '重新修复'
                      : '用 pi 修复'}
              </Button>
              <Button
                variant="outline"
                onClick={() => void abortMerge()}
                disabled={busy !== null || repairRunning}
                title={repairRunning ? '先在中止 pi 修复，再放弃合并' : '回到拉取前的状态'}
              >
                放弃合并
              </Button>
            </div>
          </div>
          {conflicted.length > 0 ? (
            <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed text-amber-800">
              {conflicted.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <RepairDrawer
        open={drawerOpen}
        repairId={repairId}
        files={repairFiles}
        onClose={() => setDrawerOpen(false)}
        onStatusChange={setRepairRunning}
        onFinished={onRepairFinished}
      />

      {repairRunning && !drawerOpen ? (
        <button
          type="button"
          className="text-[11px] text-zinc-500 underline-offset-2 hover:underline"
          onClick={() => setDrawerOpen(true)}
        >
          pi 正在后台修复冲突，点此查看进度
        </button>
      ) : null}
    </div>
  );
}

type LogItem = Extract<RepairEventRecord, { type: 'text' | 'tool' | 'log' }>;

function RepairDrawer({
  open,
  repairId,
  files,
  onClose,
  onStatusChange,
  onFinished,
}: {
  open: boolean;
  repairId: string | null;
  files: string[];
  onClose: () => void;
  onStatusChange: (running: boolean) => void;
  onFinished: () => void;
}) {
  const [events, setEvents] = useState<RepairEventRecord[]>([]);
  const [status, setStatus] = useState<RepairStatus>('running');
  const [statusText, setStatusText] = useState('正在启动 pi…');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [aborting, setAborting] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const doneRef = useRef(false);
  const statusRef = useRef<RepairStatus>('running');
  const logRef = useRef<HTMLDivElement>(null);
  const onFinishedRef = useRef(onFinished);
  const onStatusChangeRef = useRef(onStatusChange);
  onFinishedRef.current = onFinished;
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    statusRef.current = status;
    // 没有任务时不要通知父级「运行中」；否则抽屉一挂载就会显示后台修复入口
    if (repairId) onStatusChangeRef.current(status === 'running');
  }, [status, repairId]);

  useEffect(() => {
    // 抽屉收起也要保持订阅：后台修复完成时才能刷新状态、松开「放弃合并」
    if (!repairId) return;
    doneRef.current = false;
    setEvents([]);
    setStatus('running');
    statusRef.current = 'running';
    setStatusText('正在启动 pi…');
    setError('');
    setConnected(true);
    setAborting(false);
    setStartedAt(Date.now());
    setNow(Date.now());

    const source = new EventSource(`/api/storage/repair?id=${encodeURIComponent(repairId)}&stream=1`);
    const listeners: Array<[string, EventListener]> = [];
    for (const type of ['status', 'text', 'tool', 'log'] as const) {
      const listener = (raw: Event) => {
        const event = raw as MessageEvent<string>;
        try {
          const record = JSON.parse(event.data) as RepairEventRecord;
          setEvents((prev) => (prev.some((item) => item.seq === record.seq) ? prev : [...prev, record]));
          if (record.type === 'status') {
            setStatus(record.status);
            if (record.text) setStatusText(record.text);
            if (record.status !== 'running') {
              source.close();
              if (!doneRef.current) {
                doneRef.current = true;
                onFinishedRef.current();
              }
            }
          }
        } catch {
          /* 非 JSON 帧忽略 */
        }
      };
      source.addEventListener(type, listener);
      listeners.push([type, listener]);
    }
    source.onerror = () => {
      // 任务结束后服务端主动关流也会触发 onerror；仅在 running 时提示自动重连
      if (statusRef.current === 'running') setConnected(false);
    };
    source.onopen = () => setConnected(true);

    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }, [repairId, attempt]);

  useEffect(() => {
    if (!open || status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, status]);

  const log = useMemo(
    () => events.filter((event): event is LogItem => event.type === 'text' || event.type === 'tool' || event.type === 'log'),
    [events],
  );

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log.length]);

  async function abort(): Promise<void> {
    if (!repairId) return;
    setAborting(true);
    try {
      await api.abortRepair(repairId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAborting(false);
    }
  }

  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const running = status === 'running';

  return (
    <Drawer
      open={open}
      title="冲突修复 · pi"
      subtitle={files.length > 0 ? `${files.length} 个冲突文件` : undefined}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-zinc-400">
            {running
              ? `已用时 ${elapsed}s`
              : status === 'done'
                ? '合并已提交，可继续推送'
                : '冲突现场保留，可重试或放弃合并'}
          </span>
          <div className="flex gap-2">
            {running ? (
              <Button variant="outline" onClick={() => void abort()} disabled={aborting}>
                {aborting ? '中止中…' : '中止修复'}
              </Button>
            ) : null}
            <Button onClick={onClose}>{running ? '收起' : '关闭'}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
            status === 'done'
              ? 'bg-emerald-50 text-emerald-800'
              : status === 'error'
                ? 'bg-red-50 text-red-700'
                : status === 'aborted'
                  ? 'bg-zinc-100 text-zinc-600'
                  : 'bg-amber-50 text-amber-800',
          )}
        >
          {running ? <Spinner /> : null}
          <span className="font-medium">
            {status === 'done' ? '已修复' : status === 'error' ? '修复失败' : status === 'aborted' ? '已中止' : 'pi 正在修复'}
          </span>
          <span className="min-w-0 truncate opacity-80">{statusText}</span>
        </div>

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {files.map((file) => (
              <span
                key={file}
                title={file}
                className="max-w-full truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-600"
              >
                {file}
              </span>
            ))}
          </div>
        ) : null}

        <InlineError message={error} />

        <div
          ref={logRef}
          className="max-h-[52vh] space-y-2 overflow-y-auto rounded-lg border border-zinc-100 bg-zinc-50/70 p-3"
        >
          {log.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Spinner /> 等待 pi 读取冲突文件…
            </div>
          ) : (
            log.map((event) => <LogRow key={event.seq} event={event} />)
          )}
        </div>

        {!connected && running ? (
          <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <span>事件流断开，正在自动重连；任务在服务端继续。</span>
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setConnected(true);
                setAttempt((value) => value + 1);
              }}
            >
              重新连接
            </button>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

function LogRow({ event }: { event: LogItem }) {
  if (event.type === 'text') {
    return (
      <div className="whitespace-pre-wrap border-l-2 border-emerald-300 pl-2 text-xs leading-relaxed text-zinc-700">
        {event.text}
      </div>
    );
  }
  if (event.type === 'log') {
    return (
      <div
        className={cn(
          'text-[11px] leading-relaxed',
          event.level === 'error' ? 'text-red-600' : event.level === 'warn' ? 'text-amber-700' : 'text-zinc-500',
        )}
      >
        {event.text}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 font-mono text-[11px] leading-relaxed">
      <span
        className={cn(
          'mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
          event.status === 'running' ? 'bg-amber-400' : event.status === 'error' ? 'bg-red-500' : 'bg-emerald-500',
        )}
      />
      <span className="shrink-0 text-zinc-500">{event.name}</span>
      {event.path ? <span className="min-w-0 break-all text-zinc-700">{event.path}</span> : null}
      {event.detail ? <span className="min-w-0 truncate text-zinc-400">{event.detail}</span> : null}
      {event.status === 'running' ? <Spinner className="mt-0.5 h-3 w-3 shrink-0" /> : null}
    </div>
  );
}
