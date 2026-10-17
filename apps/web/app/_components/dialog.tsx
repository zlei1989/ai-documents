'use client';
import { useEffect, type ReactNode } from 'react';
import { cn } from '@aidocs/ui';

/** 跨路由复用的轻量弹窗（无 portal、无依赖）：设置页与类型编辑器共用同一观感 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/25 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('w-full rounded-xl border border-zinc-200 bg-white shadow-xl', wide ? 'max-w-5xl' : 'max-w-2xl')}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-4 py-3">
          <div>
            <div className="text-sm font-medium">{title}</div>
            {description ? <div className="mt-0.5 text-xs text-zinc-500">{description}</div> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-zinc-400 hover:text-zinc-700">
            ✕
          </button>
        </div>
        <div className="max-h-[70dvh] overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
