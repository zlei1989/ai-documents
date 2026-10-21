'use client';
import { useEffect, useState, type MouseEvent } from 'react';
import type { Block, GeneratedImage } from '@aidocs/contracts';
import { cn } from '../lib/utils';

type ImagesBlock = Extract<Block, { kind: 'images' }>;

export interface GeneratedImagesBlockProps {
  block: ImagesBlock;
  /** 由 App 注入（assetBase + 版本）；UI 包不自己拼 /api/docs/... */
  resolveImageUrl?: (path: string) => string;
  onOpen?: (image: GeneratedImage) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, image: GeneratedImage) => void;
}

/** 消息流里的生图结果：单图大图；多图拼格子；点击放大、右键交给上层菜单。 */
export function GeneratedImagesBlock({
  block,
  resolveImageUrl,
  onOpen,
  onContextMenu,
}: GeneratedImagesBlockProps) {
  const images = block.images;
  const single = images.length === 1;
  const columns = single ? 1 : Math.min(images.length, 3);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <span>生成结果 · {images.length} 张</span>
        <span className="flex-1" />
        <span className="text-zinc-400">点击放大 · 右键复制或加入上下文</span>
      </div>
      <div
        className={cn('grid gap-1.5', single && 'grid-cols-1')}
        style={single ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {images.map((image) => (
          <GeneratedImageTile
            key={image.path}
            image={image}
            single={single}
            url={resolveImageUrl?.(image.path) ?? ''}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

function GeneratedImageTile({
  image,
  single,
  url,
  onOpen,
  onContextMenu,
}: {
  image: GeneratedImage;
  single: boolean;
  url: string;
  onOpen?: (image: GeneratedImage) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, image: GeneratedImage) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  function handleContextMenu(event: MouseEvent<HTMLElement>): void {
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event, image);
  }

  return (
    <button
      type="button"
      onClick={() => onOpen?.(image)}
      onContextMenu={handleContextMenu}
      title={image.alt || image.path}
      aria-label={image.alt || `生成图片 ${image.path}`}
      className={cn(
        'group relative w-full overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
        single ? 'block' : 'aspect-square',
        onOpen ? 'cursor-zoom-in' : 'cursor-default',
      )}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className={cn('block w-full object-contain', single ? 'max-h-64' : 'h-full')}
        />
      ) : (
        <span
          className={cn(
            'flex w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-zinc-200 px-2 py-3 text-[11px] text-zinc-500',
            single ? 'min-h-24' : 'h-full min-h-16',
          )}
        >
          <span>{failed ? '图片加载失败' : image.alt || '本地图片'}</span>
          <code className="max-w-full break-all text-[10px] text-zinc-400">{image.path}</code>
        </span>
      )}
      {image.size ? (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-zinc-900/70 px-1 py-0.5 text-[10px] leading-none text-white">
          {image.size}
        </span>
      ) : null}
    </button>
  );
}
