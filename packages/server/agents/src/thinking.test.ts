import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TypeManifestSchema } from '@aidocs/contracts';
import { buildPiSession } from './assembly';

const manifest = TypeManifestSchema.parse({ name: '临时' });
const provider = {
  id: 'p',
  name: 'p',
  protocol: 'openai' as const,
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'x',
  modelId: 'm',
};

async function levelOf(thinkingLevel?: 'off' | 'low' | 'medium' | 'high') {
  const dir = mkdtempSync(join(tmpdir(), 'aidocs-tl-'));
  try {
    const handle = await buildPiSession({
      artifactDir: dir,
      sessionsDir: join(dir, 'sessions'),
      agentDir: dir,
      manifest,
      resources: [],
      provider,
      inMemorySession: true,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    try {
      return handle.session.thinkingLevel;
    } finally {
      handle.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pi 会话真的拿到思考档位', () => {
  it('不给 = off（旧行为）；给了就能生效，而不是被模型能力 clamp 掉', async () => {
    expect(await levelOf()).toBe('off');
    expect(await levelOf('off')).toBe('off');
    expect(await levelOf('low')).toBe('low');
    expect(await levelOf('medium')).toBe('medium');
    expect(await levelOf('high')).toBe('high');
  });
});
