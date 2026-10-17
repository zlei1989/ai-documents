'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  INLINE_IMAGE_SOURCE,
  parseInlineImage,
  parseMarkdown,
  type Block,
} from './markdown-parse';
import { archifyPosterViewUrl, assetUrl, normalizeAssetPath } from '../_lib/asset-url';

/**
 * 最小 Markdown 渲染：标题 / 段落 / 列表 / 引用 / 代码块 / 行内 code·粗体·链接 / 本地图片。
 * 不引入重型依赖；图片只渲染 assets/ 下的本地资源，外链不发起网络请求。
 */

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-6 mb-2 text-2xl font-semibold tracking-tight first:mt-0',
  2: 'mt-6 mb-2 text-xl font-semibold tracking-tight first:mt-0',
  3: 'mt-5 mb-1.5 text-base font-semibold first:mt-0',
  4: 'mt-4 mb-1 text-sm font-semibold first:mt-0',
  5: 'mt-4 mb-1 text-sm font-medium first:mt-0',
  6: 'mt-4 mb-1 text-xs font-medium text-zinc-500 first:mt-0',
};

export interface MarkdownImageInfo {
  /** assets/ 下的完整相对路径 */
  path: string;
  alt: string;
  /** Archify 海报：编辑入口是源 JSON；海报本身只读 */
  archify: boolean;
}

interface ImageContextValue {
  assetBase?: string;
  version?: number | string;
  onImageContextMenu?: (event: React.MouseEvent<HTMLElement>, info: MarkdownImageInfo) => void;
  /** 点击 Archify 海报在新标签打开交互 viewer（只读页用） */
  openArchifyOnClick?: boolean;
}

const ImageContext = createContext<ImageContextValue>({});

function MarkdownImage({
  alt,
  src,
  title,
  variant,
}: {
  alt: string;
  src: string;
  title?: string;
  variant: 'block' | 'inline';
}) {
  const { assetBase, version, onImageContextMenu, openArchifyOnClick } = useContext(ImageContext);
  const [failed, setFailed] = useState(false);
  const path = normalizeAssetPath(src);
  const url = path && assetBase ? assetUrl(assetBase, path, version) : null;

  useEffect(() => {
    setFailed(false);
  }, [src, version]);

  if (!path) {
    const external = /^https?:\/\//i.test(src);
    if (external) {
      return (
        <a href={src} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-2">
          {alt || '外部图片'}（外部图片未加载）
        </a>
      );
    }
    return (
      <span className="rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[12px] text-zinc-500">
        {alt || '图片'}：<code className="break-all">{src}</code>
      </span>
    );
  }

  if (!url) {
    return (
      <span className="rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[12px] text-zinc-500">
        本地图片：<code className="break-all">{path}</code>
      </span>
    );
  }

  const archify = path.toLowerCase().endsWith('.archify.svg');
  const hint = onImageContextMenu && archify ? '右键打开交互图示 / 编辑 JSON' : undefined;
  // 海报只读；点击在新标签打开同一张图的交互版
  const viewerHref = archify && openArchifyOnClick && assetBase ? archifyPosterViewUrl(assetBase, path) : null;

  function handleContextMenu(event: React.MouseEvent<HTMLElement>) {
    if (!onImageContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onImageContextMenu(event, { path: path!, alt, archify });
  }

  const body = failed ? (
    <span
      onContextMenu={handleContextMenu}
      className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-[12px] text-zinc-500"
      title={hint}
    >
      <span>{alt || '图片加载失败'}</span>
      <code className="max-w-full break-all text-[11px] text-zinc-400">{path}</code>
    </span>
  ) : (
    <img
      src={url}
      alt={alt}
      title={title || hint}
      loading="lazy"
      decoding="async"
      draggable={false}
      onContextMenu={handleContextMenu}
      onError={() => setFailed(true)}
      style={variant === 'block' && !archify ? { maxWidth: 'min(100%, 720px)' } : undefined}
      className={
        variant === 'block'
          ? 'mx-auto block max-w-full rounded-md border border-zinc-200 bg-white'
          : 'inline-block max-w-full align-middle'
      }
    />
  );

  const content = viewerHref ? (
    <a
      href={viewerHref}
      target="_blank"
      rel="noopener noreferrer"
      title="在新标签打开交互图示"
      className={`cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
        variant === 'inline' ? 'inline-block max-w-full align-middle' : 'block max-w-full'
      }`}
    >
      {body}
    </a>
  ) : (
    body
  );

  if (variant === 'inline') return content;

  return (
    <figure className="my-4 flex flex-col items-center gap-1.5">
      {content}
      {title ? <figcaption className="text-center text-[12px] text-zinc-500">{title}</figcaption> : null}
    </figure>
  );
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const split = new RegExp(
    `(${INLINE_IMAGE_SOURCE}|\`[^\`\\n]*\`|\\*\\*[^*\\n]+\\*\\*|\\[[^\\]\\n]+\\]\\([^)\\n]+\\))`,
    'g',
  );
  const parts = text.split(split);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('![')) {
      const image = parseInlineImage(part);
      if (image) {
        return <MarkdownImage key={key} alt={image.alt} src={image.src} {...(image.title ? { title: image.title } : {})} variant="inline" />;
      }
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={key} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.88em] text-zinc-700">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const label = link[1] ?? '';
      const href = link[2] ?? '';
      if (/^https?:\/\//.test(href)) {
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-2">
            {label}
          </a>
        );
      }
      return <span key={key}>{label}</span>;
    }
    return <span key={key}>{part}</span>;
  });
}

export interface MarkdownPreviewProps {
  source: string;
  /** 例如 /api/docs/<group>/<name>；不给则不渲染本地图片 */
  assetBase?: string;
  /** 图片缓存版本：保存后 +1 让 <img> 重新请求 */
  imageVersion?: number | string;
  /** 右键本地图片：由创作页接管（/docs 只读不传） */
  onImageContextMenu?: (event: React.MouseEvent<HTMLElement>, info: MarkdownImageInfo) => void;
  /** 点击 Archify 海报在新标签打开交互图示（/docs 只读页用；创作页走右键菜单） */
  openArchifyOnClick?: boolean;
}

export function MarkdownPreview({
  source,
  assetBase,
  imageVersion,
  onImageContextMenu,
  openArchifyOnClick,
}: MarkdownPreviewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const contextValue = useMemo(
    () => ({ assetBase, version: imageVersion, onImageContextMenu, openArchifyOnClick }),
    [assetBase, imageVersion, onImageContextMenu, openArchifyOnClick],
  );

  if (!source.trim()) {
    return <p className="text-sm text-zinc-400">（MAIN.md 还是空的，点「编辑」开始写）</p>;
  }
  return (
    <ImageContext.Provider value={contextValue}>
      <div className="w-full min-w-0 text-[clamp(15px,0.55vw+7px,18px)] leading-[1.75] text-zinc-800">
        {blocks.map((block, index) => {
          const key = `block-${index}`;
          return renderBlock(block, key);
        })}
      </div>
    </ImageContext.Provider>
  );
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const className = HEADING_CLASS[block.level] ?? HEADING_CLASS[3];
      const content = renderInline(block.text, key);
      if (block.level === 1) return <h1 key={key} className={className}>{content}</h1>;
      if (block.level === 2) return <h2 key={key} className={className}>{content}</h2>;
      if (block.level === 3) return <h3 key={key} className={className}>{content}</h3>;
      if (block.level === 4) return <h4 key={key} className={className}>{content}</h4>;
      return <h5 key={key} className={className}>{content}</h5>;
    }
    case 'paragraph':
      return (
        <p key={key} className="my-3 whitespace-pre-wrap first:mt-0">
          {renderInline(block.text, key)}
        </p>
      );
    case 'image':
      return (
        <MarkdownImage
          key={key}
          alt={block.alt}
          src={block.src}
          {...(block.title ? { title: block.title } : {})}
          variant="block"
        />
      );
    case 'code':
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-100">
          {block.lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{block.lang}</div> : null}
          <code>{block.code}</code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={key} className="my-3 list-disc space-y-1 pl-5">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="my-3 list-decimal space-y-1 pl-5">
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={key} className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600">
          {renderInline(block.text, key)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="my-5 border-zinc-200" />;
    default:
      return null;
  }
}
