'use client';
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** 作用在包裹层上的类名（宽度、外边距等）；下拉框本身始终铺满包裹层。 */
  wrapperClassName?: string;
}

/**
 * 原生 select + 自绘外观：关掉 `appearance` 后浏览器不再画系统下拉箭头，
 * 由右侧 ChevronDown 承担指示，避免 macOS/Windows 原生控件皮肤与界面其余部分打架。
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, children, ...props }, ref) => (
    <span className={cn('relative block w-full', wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          'h-8 w-full cursor-pointer appearance-none rounded-md border border-zinc-200 bg-white pl-2 pr-7 text-sm text-zinc-900 outline-none transition-colors hover:border-zinc-300 focus-visible:border-zinc-400 focus-visible:ring-2 focus-visible:ring-zinc-300 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
      />
    </span>
  ),
);
Select.displayName = 'Select';
