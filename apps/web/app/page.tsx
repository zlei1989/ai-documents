import Link from 'next/link';
import { Button } from '@aidocs/ui';

export default function HomePage() {
  return (
    <main className="flex min-h-dvh w-full flex-col justify-center gap-6 px-5 py-12 sm:gap-8 sm:px-8 md:px-12 lg:px-16 xl:px-20">
      <div className="w-full max-w-none space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl lg:text-4xl">我的文档</h1>
        <p className="text-sm text-zinc-500 sm:text-base">
          本地 Markdown 创作工作台 · 已加载 spec v1 骨架（M1）
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/settings">
          <Button variant="outline">设置</Button>
        </Link>
        <Link href="/docs">
          <Button>文档</Button>
        </Link>
      </div>
      <p className="text-xs text-zinc-400">
        实现进行中：M2 设置页 / M3 存储与类型 / M4 pi 会话。
      </p>
    </main>
  );
}
