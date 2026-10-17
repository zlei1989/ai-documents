import { ensureRuntime } from '@aidocs/api';
import { readConfig } from '@aidocs/core';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const cfg = readConfig();
  const rt = await ensureRuntime('产品', 'E2E测试');
  const p = rt.session.systemPrompt ?? '';
  return Response.json({ len: p.length, hasSkills: p.includes('<skills>'), skillsLen: p.indexOf('<skills>') >= 0 ? p.length - p.indexOf('<skills>') : 0, configured: cfg.settings.storageRoot });
}
