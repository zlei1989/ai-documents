import * as React from 'react';
import { cn } from '../../lib/utils';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11.5px] text-zinc-600', className)}
      {...props}
    />
  );
}
