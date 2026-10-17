'use client';
import * as React from 'react';
import { cn } from '../../lib/utils';

/** 极简受控 Tabs（后续可换 shadcn 版） */
export function Tabs({
  value,
  onValueChange,
  items,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-lg bg-zinc-100 p-1', className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onValueChange(item.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs transition-colors',
            value === item.value ? 'bg-white font-medium shadow-sm' : 'text-zinc-500 hover:text-zinc-800',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
