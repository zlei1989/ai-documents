'use client';

import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { archifyPosterViewUrl, assetUrl, normalizeAssetPath } from '../_lib/asset-url';

/**
 * Markdown 渲染：react-markdown + remark-gfm 负责解析（CommonMark + GFM 表格/删除线/
 * 任务列表/脚注/自动链接），本文件只负责把元素映射成站内样式与本地资源策略：
 * - 图片只渲染 assets/ 下的本地资源，外链不发起网络请求
 * - Archify 海报保留右键菜单（创作页）与点击打开交互 viewer（只读页）
 * - 代码块保留语言标签，行内代码/链接/标题等对齐原有视觉
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

/** 独占一段的图片用 block 版式（figure + 图题），行内图片保持 inline */
const StandaloneImageContext = createContext(false);

/** 代码块外层的 <pre> 里，<code> 不应再套行内代码底色 */
const InPreContext = createContext(false);

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
  const hint = onImageContextMenu
    ? archify
      ? '右键复制图片 / 打印 / 打开交互图示 / 编辑 JSON'
      : '右键复制图片 / 打印'
    : undefined;
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

/** 段落里是否只有一个图片节点（决定用 figure 还是行内图片） */
function isStandaloneImage(node: ExtraProps['node']): boolean {
  if (!node || node.type !== 'element') return false;
  const meaningful = node.children.filter((child) => child.type !== 'text' || child.value.trim() !== '');
  return meaningful.length === 1 && meaningful[0]?.type === 'element' && meaningful[0].tagName === 'img';
}

function isExternal(href: string | undefined): boolean {
  return /^https?:\/\//i.test(href ?? '');
}

/** 代码块语言：react-markdown 给 <code> 加 language-xxx */
function languageOf(children: ReactNode): string {
  const first = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string }>(first)) return '';
  return /language-([\w+#.-]+)/.exec(first.props.className ?? '')?.[1] ?? '';
}

function Pre({ children }: ComponentPropsWithoutRef<'pre'>) {
  const lang = languageOf(children);
  return (
    <pre className="my-3 overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-100">
      {lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{lang}</div> : null}
      <InPreContext.Provider value>{children}</InPreContext.Provider>
    </pre>
  );
}

function Code({ className, children }: ComponentPropsWithoutRef<'code'>) {
  const inPre = useContext(InPreContext);
  if (inPre) return <code className={className}>{children}</code>;
  return (
    <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.88em] text-zinc-700">{children}</code>
  );
}

function Paragraph({ node, children }: ComponentPropsWithoutRef<'p'> & ExtraProps) {
  if (isStandaloneImage(node)) {
    return <StandaloneImageContext.Provider value>{children}</StandaloneImageContext.Provider>;
  }
  return <p className="my-3 whitespace-pre-wrap first:mt-0">{children}</p>;
}

/** react-markdown 会把 URL 里的非 ASCII 百分号编码；本地路径先还原，避免二次编码 */
function decodeUrlOnce(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function Image({ src, alt, title }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const standalone = useContext(StandaloneImageContext);
  return (
    <MarkdownImage
      alt={alt ?? ''}
      src={typeof src === 'string' ? decodeUrlOnce(src) : ''}
      {...(title ? { title } : {})}
      variant={standalone ? 'block' : 'inline'}
    />
  );
}

function Link({ href, children }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  if (isExternal(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 underline underline-offset-2"
      >
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

function Table({ children }: ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="my-4 w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

function TableHead({ children }: ComponentPropsWithoutRef<'thead'>) {
  return <thead>{children}</thead>;
}

function TableCell({ children, style }: ComponentPropsWithoutRef<'th'>) {
  return (
    <th style={style} className="border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-left font-semibold">
      {children}
    </th>
  );
}

function DataCell({ children, style }: ComponentPropsWithoutRef<'td'>) {
  return (
    <td style={style} className="border border-zinc-200 px-3 py-1.5 align-top">
      {children}
    </td>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className={HEADING_CLASS[1]}>{children}</h1>,
  h2: ({ children }) => <h2 className={HEADING_CLASS[2]}>{children}</h2>,
  h3: ({ children }) => <h3 className={HEADING_CLASS[3]}>{children}</h3>,
  h4: ({ children }) => <h4 className={HEADING_CLASS[4]}>{children}</h4>,
  h5: ({ children }) => <h5 className={HEADING_CLASS[5]}>{children}</h5>,
  h6: ({ children }) => <h6 className={HEADING_CLASS[6]}>{children}</h6>,
  p: Paragraph,
  a: Link,
  img: Image,
  pre: Pre,
  code: Code,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-5 marker:text-zinc-400 [&_ul]:my-1 [&_ol]:my-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-zinc-400 [&_ul]:my-1 [&_ol]:my-1">{children}</ol>
  ),
  li: ({ children }) => <li className="[&>p]:my-0 [&>p]:whitespace-normal">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600 [&>p]:my-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-zinc-200" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-zinc-500 line-through">{children}</del>,
  table: Table,
  thead: TableHead,
  th: TableCell,
  td: DataCell,
};

const REMARK_PLUGINS = [remarkGfm];

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
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {source}
        </Markdown>
      </div>
    </ImageContext.Provider>
  );
}
