'use client';

export function ArchifyPreviewFrame({ url, revision }: { url: string; revision: string }) {
  return (
    <div className="relative h-full min-h-[360px] w-full bg-white">
      <iframe
        key={`${url}-${revision}`}
        src={url}
        title="Archify 交互预览"
        sandbox="allow-scripts"
        className="h-full w-full border-0"
      />
    </div>
  );
}
