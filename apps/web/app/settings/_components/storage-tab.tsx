'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, Input } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { GitSyncSection } from './git-sync';
import { Field, InlineError, InlineHint, Spinner, Toggle } from './primitives';
import { useToast } from './toast';

export function StorageTab() {
  const toast = useToast();
  const state = useLoader(api.getSettings);
  const initialized = useRef(false);

  const [pathInput, setPathInput] = useState('');
  const [pathError, setPathError] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [initializing, setInitializing] = useState(false);

  const [autoCommit, setAutoCommit] = useState(true);
  const [aiSeconds, setAiSeconds] = useState('2');
  const [humanSeconds, setHumanSeconds] = useState('8');
  const [savingCommit, setSavingCommit] = useState(false);
  const [commitError, setCommitError] = useState('');

  useEffect(() => {
    if (!state.data || initialized.current) return;
    initialized.current = true;
    setPathInput(state.data.storage.storageRoot);
    setAutoCommit(state.data.settings.autoCommit);
    setAiSeconds(String(Math.round(state.data.settings.aiCommitDebounceMs / 1000)));
    setHumanSeconds(String(Math.round(state.data.settings.humanCommitDebounceMs / 1000)));
  }, [state.data]);

  const git = state.data?.storage.git;

  async function savePath() {
    const target = pathInput.trim();
    if (!target) {
      setPathError('请填写存储目录的绝对路径');
      return;
    }
    setSavingPath(true);
    setPathError('');
    try {
      const next = await api.updateSettings({ storageRoot: target });
      setPathInput(next.storage.storageRoot);
      toast.success('存储目录已更新');
      await state.reload();
    } catch (error) {
      setPathError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setSavingPath(false);
    }
  }

  async function initGit() {
    setInitializing(true);
    try {
      const next = await api.initStorage();
      toast.success(next.git.isRepo ? '版本历史已初始化' : '初始化未完成');
      await state.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setInitializing(false);
    }
  }

  async function saveCommitSettings() {
    const aiMs = Math.round(Number(aiSeconds) * 1000);
    const humanMs = Math.round(Number(humanSeconds) * 1000);
    if (!Number.isFinite(aiMs) || aiMs < 0 || !Number.isFinite(humanMs) || humanMs < 0) {
      setCommitError('debounce 必须是 ≥ 0 的秒数');
      return;
    }
    setSavingCommit(true);
    setCommitError('');
    try {
      const next = await api.updateSettings({
        autoCommit,
        aiCommitDebounceMs: aiMs,
        humanCommitDebounceMs: humanMs,
      });
      setAutoCommit(next.settings.autoCommit);
      setAiSeconds(String(Math.round(next.settings.aiCommitDebounceMs / 1000)));
      setHumanSeconds(String(Math.round(next.settings.humanCommitDebounceMs / 1000)));
      toast.success('自动提交设置已保存');
      await state.reload();
    } catch (error) {
      setCommitError(errorMessage(error));
      toast.error(errorMessage(error));
    } finally {
      setSavingCommit(false);
    }
  }

  if (state.loading && !state.data) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Spinner /> 加载存储设置…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <InlineError message={state.error} />

      <Card>
        <CardHeader>
          <div>
            <div className="text-sm font-medium">存储目录</div>
            <div className="text-[11px] text-zinc-400">用户内容都在这里；密钥不落此目录</div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="路径" hint="必须写绝对路径；允许用户主目录子目录、/Volumes 或临时目录">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                placeholder="/Users/you/Documents/我的文档"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button onClick={() => void savePath()} disabled={savingPath}>
                {savingPath ? '校验中…' : '保存路径'}
              </Button>
            </div>
          </Field>
          <InlineError message={pathError} />
          <InlineHint>
            切换存储目录不会搬运数据，只切换视图。初始化版本历史后，每个文档的 AI 改动与人工编辑都可回滚。
          </InlineHint>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">版本历史（git）</div>
            <div className="text-[11px] text-zinc-400">本地提交与回滚；拉取/推送遇到冲突交给 pi 修复</div>
          </div>
          {git?.isRepo ? <Badge className="bg-emerald-50 text-emerald-700">已初始化</Badge> : <Badge>未初始化</Badge>}
        </CardHeader>
        <CardContent className="space-y-3">
          {git?.isRepo ? (
            <>
              <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-xs text-zinc-500">当前分支</dt>
                <dd className="font-mono text-xs">{git.branch ?? '（detached HEAD）'}</dd>
                <dt className="text-xs text-zinc-500">最近提交</dt>
                <dd className="text-xs">
                  {git.lastCommit ? (
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-zinc-500">{git.lastCommit.shortSha}</span>
                      <span>{git.lastCommit.summary}</span>
                      <span className="text-zinc-400">
                        {git.lastCommit.author} · {formatTime(git.lastCommit.at)}
                      </span>
                    </span>
                  ) : (
                    '还没有提交'
                  )}
                </dd>
                <dt className="text-xs text-zinc-500">未提交变更</dt>
                <dd className="text-xs">
                  {git.dirty ? <span className="text-amber-600">有</span> : '无'}
                  {git.conflicted.length > 0 ? (
                    <span className="ml-2 text-amber-600">冲突 {git.conflicted.length} 个文件</span>
                  ) : null}
                </dd>
              </dl>
              <GitSyncSection git={git} onChanged={state.reload} />
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-zinc-600">该目录还不是 git 仓库。</p>
              <Button onClick={() => void initGit()} disabled={initializing || !state.data?.storage.storageRoot}>
                {initializing ? '初始化中…' : '初始化版本历史'}
              </Button>
              {!state.data?.storage.storageRoot ? <span className="text-xs text-zinc-400">请先保存存储路径</span> : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <div className="text-sm font-medium">自动提交</div>
            <div className="text-[11px] text-zinc-400">按文档路径限定提交，不卷入其它文档</div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Toggle checked={autoCommit} onChange={setAutoCommit} label="自动提交" />
            <div className="text-sm">
              {autoCommit ? '开启：改动后自动提交' : '关闭：只保留手动提交'}
              <div className="text-[11px] text-zinc-400">默认开启</div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="AI 轮结束 debounce（秒）" hint="默认 2 秒">
              <Input
                type="number"
                min={0}
                step={0.5}
                value={aiSeconds}
                onChange={(event) => setAiSeconds(event.target.value)}
              />
            </Field>
            <Field label="人工保存 debounce（秒）" hint="默认 8 秒">
              <Input
                type="number"
                min={0}
                step={0.5}
                value={humanSeconds}
                onChange={(event) => setHumanSeconds(event.target.value)}
              />
            </Field>
          </div>
          <InlineError message={commitError} />
          <div className="flex justify-end">
            <Button onClick={() => void saveCommitSettings()} disabled={savingCommit}>
              {savingCommit ? '保存中…' : '保存自动提交设置'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
