import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '我的文档',
  description: '本地 Markdown 创作工作台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
