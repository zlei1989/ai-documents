'use client';
import * as React from 'react';
import type { ClarificationBlock } from '@aidocs/contracts';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';

/**
 * 澄清选择卡：AI 动笔前问 1–3 个带选项的问题，用户选完/跳过后再继续同一轮创作。
 * 选择结果通过 onSubmit 回传；卡片自身只负责收集与展示状态。
 */
export function ClarificationCard({
  block,
  disabled = false,
  onSubmit,
}: {
  block: ClarificationBlock;
  disabled?: boolean;
  onSubmit: (groupId: string, answers: Record<string, string>) => Promise<void>;
}) {
  const pending = block.status === 'pending';
  const [selected, setSelected] = React.useState<Record<string, string>>({});
  const [otherActive, setOtherActive] = React.useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [draftLoaded, setDraftLoaded] = React.useState(false);
  const draftKey = `aidocs.clarify.${block.groupId}`;

  // 刷新后恢复「还没提交」的选择；已提交的答案以 ui.jsonl 里的 answered 快照为准。
  React.useEffect(() => {
    if (!pending) {
      setDraftLoaded(true);
      return;
    }
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as {
          selected?: Record<string, string>;
          otherActive?: Record<string, boolean>;
          otherText?: Record<string, string>;
        };
        if (draft.selected && typeof draft.selected === 'object') setSelected(draft.selected);
        if (draft.otherActive && typeof draft.otherActive === 'object') setOtherActive(draft.otherActive);
        if (draft.otherText && typeof draft.otherText === 'object') setOtherText(draft.otherText);
      }
    } catch {
      /* 本地草稿损坏时忽略 */
    }
    setDraftLoaded(true);
  }, [draftKey, pending]);

  React.useEffect(() => {
    if (!pending || !draftLoaded) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ selected, otherActive, otherText }));
    } catch {
      /* 隐私模式等写入失败时忽略 */
    }
  }, [draftKey, pending, draftLoaded, selected, otherActive, otherText]);

  React.useEffect(() => {
    if (block.status === 'pending') return;
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [block.status, draftKey]);

  const answers: Record<string, string> = {};
  for (const question of block.questions) {
    const value = otherActive[question.id] ? (otherText[question.id] ?? '') : (selected[question.id] ?? '');
    if (value.trim()) answers[question.id] = value.trim();
  }
  const complete = block.questions.every((question) => Boolean(answers[question.id]));
  const canInteract = pending && !disabled && !busy;

  function choose(questionId: string, value: string): void {
    setOtherActive((prev) => ({ ...prev, [questionId]: false }));
    setSelected((prev) => ({ ...prev, [questionId]: value }));
  }

  function chooseOther(questionId: string): void {
    setOtherActive((prev) => ({ ...prev, [questionId]: true }));
  }

  function editOther(questionId: string, value: string): void {
    setOtherText((prev) => ({ ...prev, [questionId]: value }));
  }

  async function submit(skip: boolean): Promise<void> {
    if (busy || disabled) return;
    const outgoing: Record<string, string> = { ...answers };
    if (skip) {
      for (const question of block.questions) {
        if (!outgoing[question.id]) outgoing[question.id] = '未指定（按最合理判断）';
      }
    }
    if (!skip && block.questions.some((question) => !outgoing[question.id])) {
      setError('请把每道题都选完，或点「跳过」让 AI 按默认写。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(block.groupId, outgoing);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    } catch (submitError) {
      setError((submitError as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">需要澄清</span>
        {pending ? (
          <span className="text-[11px] text-amber-700">
            {disabled ? '等待会话恢复…' : '选完 AI 会继续写，不会另起一轮'}
          </span>
        ) : block.status === 'answered' ? (
          <span className="text-[11px] text-emerald-700">已答复 · AI 继续创作</span>
        ) : (
          <span className="text-[11px] text-zinc-500">已失效，AI 按默认继续</span>
        )}
      </div>

      {block.intro ? <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-900">{block.intro}</p> : null}

      {pending ? (
        <div className="mt-2 space-y-2.5">
        {block.questions.map((question) => {
          const chosen = answers[question.id];
          return (
            <div key={question.id}>
              <p className="text-[12.5px] font-medium leading-relaxed text-zinc-800">{question.text}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const active = !otherActive[question.id] && chosen === option.value;
                  return (
                    <button
                      key={`${question.id}-${option.value}`}
                      type="button"
                      aria-pressed={active}
                      disabled={!canInteract}
                      onClick={() => choose(question.id, option.value)}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-left text-[12px] transition-colors disabled:cursor-default',
                        active
                          ? 'border-amber-500 bg-amber-100 text-amber-900'
                          : 'border-amber-200 bg-white text-zinc-700 hover:border-amber-300 hover:bg-amber-50 disabled:opacity-70',
                      )}
                    >
                      <span className="block font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[10.5px] font-normal text-zinc-500">{option.description}</span>
                      ) : null}
                    </button>
                  );
                })}
                {question.allowOther ? (
                  <button
                    type="button"
                    aria-pressed={Boolean(otherActive[question.id])}
                    disabled={!canInteract}
                    onClick={() => chooseOther(question.id)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-[12px] transition-colors disabled:cursor-default',
                      otherActive[question.id]
                        ? 'border-amber-500 bg-amber-100 text-amber-900'
                        : 'border-dashed border-amber-300 bg-white text-zinc-600 hover:bg-amber-50 disabled:opacity-70',
                    )}
                  >
                    其他…
                  </button>
                ) : null}
              </div>
              {question.allowOther && otherActive[question.id] && canInteract ? (
                <input
                  value={otherText[question.id] ?? ''}
                  onChange={(event) => editOther(question.id, event.target.value)}
                  placeholder="输入你的答案"
                  className="mt-1.5 w-full rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-amber-400"
                />
              ) : null}
            </div>
          );
        })}
        </div>
      ) : null}

      {pending ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button onClick={() => void submit(false)} disabled={!canInteract || !complete}>
            {busy ? '提交中…' : '提交选择'}
          </Button>
          <Button variant="ghost" onClick={() => void submit(true)} disabled={!canInteract}>
            跳过，按默认写
          </Button>
          {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
        </div>
      ) : block.status === 'answered' ? (
        <div className="mt-2 space-y-0.5 border-t border-amber-200/70 pt-1.5">
          {block.questions.map((question) => (
            <p key={question.id} className="text-[11.5px] leading-relaxed text-zinc-600">
              <span className="text-zinc-400">{question.text}</span>
              <span className="mx-1 text-zinc-300">→</span>
              <span className="font-medium text-zinc-800">{block.answers?.[question.id] ?? '未指定'}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
