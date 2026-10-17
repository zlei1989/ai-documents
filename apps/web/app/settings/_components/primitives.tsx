'use client';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn, Input, Select as BaseSelect } from '@aidocs/ui';
import { Dialog } from '../../_components/dialog';

export { Dialog };

/** 设置页本地的基础件：弹窗 / 抽屉 / 表单行 / 下拉 / 开关。不污染共享 ui 包，减少并行开发的冲突面。 */

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/20" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="flex h-full w-[min(560px,92vw)] flex-col border-l border-zinc-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{title}</div>
            {subtitle ? <div className="truncate text-xs text-zinc-500">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-zinc-400 hover:text-zinc-700">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <div className="border-t border-zinc-100 px-4 py-3">{footer}</div> : null}
      </aside>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-zinc-600">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-zinc-400">{hint}</span> : null}
      {error ? <span className="block text-[11px] text-red-600">{error}</span> : null}
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <BaseSelect
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      wrapperClassName={className}
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </BaseSelect>
  );
}

export interface ComboBoxOption {
  value: string;
  hint?: string;
}

/**
 * 可输入的下拉框：点输入框或箭头展开预设，打字时按输入过滤，↑↓ 移动、回车选中。
 * 输入框始终可写，所以预设之外的模型 ID / Endpoint ID 也能直接填。
 */
export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboBoxOption[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** null = 展开全部预设；字符串 = 按当前输入过滤 */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);

  const filtered = useMemo(() => {
    if (query === null) return options;
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.value.toLowerCase().includes(needle));
  }, [options, query]);

  const isCustom = value.trim().length > 0 && !options.some((option) => option.value === value.trim());
  const activeId = open && active >= 0 && filtered[active] ? `${listId}-${active}` : undefined;

  function close() {
    setOpen(false);
    setQuery(null);
    setActive(-1);
  }

  function openList() {
    setQuery(null);
    setActive(options.findIndex((option) => option.value === value.trim()));
    setOpen(true);
  }

  function choose(next: string) {
    onChange(next);
    close();
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (filtered.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) =>
        prev < 0
          ? delta > 0
            ? 0
            : filtered.length - 1
          : (prev + delta + filtered.length) % filtered.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const option = filtered[active];
      if (option) choose(option.value);
      else close();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') close();
  }

  return (
    <div ref={rootRef} className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setQuery(next);
          setActive(0);
          setOpen(true);
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        className="pr-8 font-mono text-xs"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? '收起模型预设' : '展开模型预设'}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          inputRef.current?.focus();
          openList();
        }}
        className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
          <div
            id={listId}
            role="listbox"
            aria-label={ariaLabel ?? '预设模型'}
            className="max-h-56 overflow-y-auto p-1"
          >
            {filtered.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value.trim()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(option.value);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5',
                  index === active ? 'bg-zinc-100' : 'hover:bg-zinc-50',
                )}
              >
                <span className="min-w-0 truncate font-mono text-xs text-zinc-800">{option.value}</span>
                {option.hint ? (
                  <span className="hidden shrink-0 text-[10px] text-zinc-400 sm:inline">{option.hint}</span>
                ) : null}
              </div>
            ))}
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-zinc-400">没有匹配的预设，保留当前输入即可</div>
            ) : null}
          </div>
          {isCustom ? (
            <div className="border-t border-zinc-100 px-2.5 py-1.5 text-[10px] text-zinc-400">
              当前为自定义值，可直接编辑
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-zinc-900' : 'bg-zinc-300',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700', className)}
    />
  );
}

export function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{message}</p>;
}

export function InlineHint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-zinc-400">{children}</p>;
}
