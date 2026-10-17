import type { Metadata } from 'next';
import { SettingsClient } from './_components/settings-client';

export const metadata: Metadata = {
  title: '设置 · 我的文档',
};

export default function SettingsPage() {
  return <SettingsClient />;
}
