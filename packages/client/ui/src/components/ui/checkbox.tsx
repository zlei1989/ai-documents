'use client';
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 自绘勾选框：真实 input 承担交互与可访问性，只把原生外观关掉，
 * 勾号用覆盖在上层的图标画，避免各平台原生 checkbox 皮肤不一致。
 */
export const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <span className={cn('relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[3px] border border-zinc-300 bg-white outline-none transition-colors checked:border-zinc-900 checked:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3.5}
        className="pointer-events-none relative h-2.5 w-2.5 text-white opacity-0 peer-checked:opacity-100 peer-disabled:opacity-50"
      />
    </span>
  ),
);
Checkbox.displayName = 'Checkbox';
