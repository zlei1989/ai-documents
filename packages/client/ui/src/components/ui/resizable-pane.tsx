'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface PaneBounds {
  min: number;
  max: number;
}

export interface UseResizablePaneOptions {
  /** 面板当前宽度；null 表示客户端尚未确定（首帧由 CSS 兜底）。 */
  width: number | null;
  /** 宽度变化时回调，值已按 bounds 钳制。 */
  onChange: (width: number) => void;
  /** 一次调整结束时回调（松手 / 键盘 / 复位），适合持久化。 */
  onCommit?: (width: number) => void;
  /** 默认宽度；双击复位用，也作为 width 未确定时的拖拽起点。 */
  defaultWidth: (viewportWidth: number) => number;
  /** 当前视口下允许的宽度范围。 */
  bounds: (viewportWidth: number) => PaneBounds;
  /** 面板位于把手哪一侧：`start` = 左栏（右拖变宽），`end` = 右栏（左拖变宽）。默认 `start`。 */
  edge?: 'start' | 'end';
  /** 方向键步长，默认 16px；按住 Shift 时 ×4。 */
  step?: number;
}

export interface ResizablePane {
  dragging: boolean;
  /** 展开到把手元素上的交互与可访问性属性。 */
  handleProps: React.HTMLAttributes<HTMLDivElement>;
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

function clampTo(value: number, bounds: PaneBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/**
 * 分隔栏拖拽：指针拖动、方向键微调、双击复位、随视口变化重新钳制。
 * 宽度是受控的——持久化策略留给调用方（在 `onCommit` 里写 localStorage）。
 */
export function useResizablePane(options: UseResizablePaneOptions): ResizablePane {
  const { width, edge = 'start', step = 16 } = options;
  const [dragging, setDragging] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const lastRef = React.useRef<number | null>(width);
  // 回调随每次渲染更新，事件处理器里始终读最新值，避免把函数放进依赖导致重复订阅。
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    lastRef.current = width;
  }, [width]);

  const resolveWidth = React.useCallback((): number => {
    const current = optionsRef.current;
    if (current.width !== null) return current.width;
    const vw = viewportWidth();
    return clampTo(current.defaultWidth(vw), current.bounds(vw));
  }, []);

  // 视口变化后把宽度收回合法区间（例如窗口缩小后左栏不能挤没文档区）。
  React.useEffect(() => {
    const onResize = () => {
      const current = optionsRef.current;
      if (current.width === null) return;
      const next = clampTo(current.width, current.bounds(window.innerWidth));
      if (next !== current.width) current.onChange(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 拖动期间锁定光标与选区，避免划过文档区时选中文字。
  React.useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  function update(next: number): void {
    const current = optionsRef.current;
    const clamped = clampTo(next, current.bounds(viewportWidth()));
    lastRef.current = clamped;
    current.onChange(clamped);
  }

  function commit(): void {
    const current = optionsRef.current;
    if (lastRef.current !== null) current.onCommit?.(lastRef.current);
  }

  const handleProps: React.HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '拖动调整面板宽度',
    tabIndex: 0,
    // 视口宽度只在客户端可知；挂载后再给出数值，避免水合期属性不一致。
    ...(mounted && width !== null
      ? {
          'aria-valuenow': Math.round(width),
          'aria-valuemin': optionsRef.current.bounds(viewportWidth()).min,
          'aria-valuemax': optionsRef.current.bounds(viewportWidth()).max,
        }
      : {}),
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.focus({ preventScroll: true });
      target.setPointerCapture?.(event.pointerId);
      const startWidth = resolveWidth();
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth };
      lastRef.current = startWidth;
      setDragging(true);
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const delta = event.clientX - drag.startX;
      update(drag.startWidth + (optionsRef.current.edge === 'end' ? -delta : delta));
    },
    onPointerUp: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setDragging(false);
      commit();
    },
    onPointerCancel: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      commit();
    },
    // 捕获被系统收回（窗口失焦、元素卸载等）时收尾，避免拖拽盾一直盖在页面上。
    onLostPointerCapture: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      commit();
    },
    onKeyDown: (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const delta = direction * step * (event.shiftKey ? 4 : 1) * (edge === 'end' ? -1 : 1);
      update(resolveWidth() + delta);
      commit();
    },
    onDoubleClick: () => {
      const current = optionsRef.current;
      update(current.defaultWidth(viewportWidth()));
      commit();
    },
  };

  return { dragging, handleProps };
}

export interface PaneResizerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'role' | 'tabIndex'> {
  width: number | null;
  onChange: (width: number) => void;
  onCommit?: (width: number) => void;
  defaultWidth: (viewportWidth: number) => number;
  bounds: (viewportWidth: number) => PaneBounds;
  edge?: 'start' | 'end';
  step?: number;
  /** 悬停提示文案，同时用作分隔栏的无障碍名称。 */
  label?: string;
}

/**
 * 6px 可拖拽分隔栏：悬停/拖动高亮，`col-resize` 光标，双击复位默认宽度。
 * 用 `hidden md:block` 之类的断点类控制只在分栏布局里出现。
 */
export function PaneResizer({
  width,
  onChange,
  onCommit,
  defaultWidth,
  bounds,
  edge,
  step,
  label = '拖动调整面板宽度（双击复位）',
  className,
  title,
  ...rest
}: PaneResizerProps) {
  const { dragging, handleProps } = useResizablePane({
    width,
    onChange,
    onCommit,
    defaultWidth,
    bounds,
    edge,
    step,
  });

  return (
    <>
      <div
        {...rest}
        {...handleProps}
        title={title ?? label}
        aria-label={label}
        className={cn(
          'w-1.5 shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors',
          'hover:bg-zinc-300/60 focus-visible:bg-zinc-300/60 focus-visible:outline-none',
          dragging && 'bg-zinc-300/70',
          className,
        )}
      />
      {/*
        拖动时盖一层全屏「拖拽盾」：指针一旦进入 iframe 等内嵌文档，父文档就收不到
        pointermove（右侧面板拖不动、光标也会变回默认），盾把命中测试留在父文档里。
        事件仍由把手通过 pointer capture 接收；盾上的处理器只是捕获失效时的兜底。
      */}
      {dragging ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[100] cursor-col-resize touch-none select-none"
          onPointerMove={handleProps.onPointerMove}
          onPointerUp={handleProps.onPointerUp}
          onPointerCancel={handleProps.onPointerCancel}
        />
      ) : null}
    </>
  );
}
