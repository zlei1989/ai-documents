import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { TypeManifestSchema } from '@aidocs/contracts';
import { ServiceError, resolveResearchConfig, resolveSeedreamConfig, resolveStorageRoot } from '@aidocs/api';
import { buildPromptPreview, type PromptPreview } from '@aidocs/agents';
import { readConfig } from '@aidocs/core';
import { readJson, route, validate } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

const PreviewBody = z.object({
  prompt: z.string(),
  manifest: TypeManifestSchema,
  /** 从某篇文档进入时为 `group/name`，决定 cwd 段 */
  doc: z.string().optional(),
});

interface Context {
  params: Promise<{ name: string }>;
}

/** 预览结果缓存：同一份草稿反复切 tab 不重复装配（装配一次约 0.3–0.6s） */
const cache = new Map<string, PromptPreview>();
const CACHE_MAX = 12;

function remember(key: string, value: PromptPreview): PromptPreview {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

/** 没有文档上下文时用临时目录当 cwd（真实创作时这里一定是文档目录） */
function fallbackCwd(): string {
  const dir = join(tmpdir(), 'aidocs-preview');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveCwd(root: string, doc: string | undefined): string {
  if (!doc) return fallbackCwd();
  const docsRoot = resolve(root, 'docs');
  const target = resolve(docsRoot, doc);
  if (target === docsRoot || !target.startsWith(docsRoot + sep)) {
    throw new ServiceError('VALIDATION', 'doc 参数不合法');
  }
  return existsSync(target) ? target : fallbackCwd();
}

/**
 * POST /api/types/:name/preview：用真实装配路径生成「模型这一轮实际收到的完整系统提示词」。
 * 草稿（prompt + manifest）来自编辑器，未保存也按草稿预览。
 */
export async function POST(request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    const body = validate(PreviewBody, await readJson(request));

    const root = resolveStorageRoot();
    const typeDir = join(root, 'types', name);
    if (!existsSync(typeDir)) throw new ServiceError('NOT_FOUND', `类型不存在：${name}`);

    const cwd = resolveCwd(root, body.doc);
    const config = readConfig();
    const selectedMcp = config.mcpServers.filter((m) => m.enabled && body.manifest.mcp.includes(m.name));
    const provider = pickPreviewProvider(config);
    // 预览必须和真实会话同一套工具：资料查询默认注入，配置可用就要能看到 research_*
    const research = resolveResearchConfig(config);
    const researchConfig = research.state === 'ready' ? research.config : undefined;
    // 生图同理：启用且配置完整才让预览里出现 seedream_image_generation
    const seedream = resolveSeedreamConfig(config);
    const seedreamConfig = seedream.state === 'ready' ? seedream.config : undefined;

    const key = createHash('sha1')
      .update(
        JSON.stringify({
          name,
          cwd,
          prompt: body.prompt,
          manifest: body.manifest,
          mcp: selectedMcp.map((m) => m.name),
          research: researchConfig
            ? [researchConfig.baseUrl, researchConfig.count, researchConfig.needContent, researchConfig.disabledSources]
            : null,
          seedream: seedreamConfig ? [seedreamConfig.baseUrl, seedreamConfig.model, seedreamConfig.size] : null,
        }),
      )
      .digest('hex');
    const cached = cache.get(key);
    if (cached) return cached;

    const preview = remember(
      key,
      await buildPromptPreview({
        typeDir,
        cwd,
        agentDir: config.settings.storageRoot || root,
        manifest: body.manifest,
        promptText: body.prompt,
        ...(selectedMcp.length > 0 ? { mcp: selectedMcp } : {}),
        ...(researchConfig ? { research: researchConfig } : {}),
        ...(seedreamConfig ? { seedream: seedreamConfig } : {}),
        provider,
      }),
    );
    return preview;
  })();
}

/** 预览不需要真能调通，只需要一个注册得进去的模型；没配供应商也照样能看提示词 */
function pickPreviewProvider(config: ReturnType<typeof readConfig>) {
  const withModels = config.providers.filter((p) => p.models.length > 0);
  const wanted = config.settings.defaultModel;
  const preferred = wanted ? withModels.find((p) => wanted.startsWith(`${p.id}/`)) : undefined;
  const provider = preferred ?? withModels[0];
  const model = provider ? (provider.models.find((m) => `${provider.id}/${m.id}` === wanted) ?? provider.models[0]!) : null;
  return provider && model
    ? {
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelId: model.id,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        supportsImages: model.supportsImages ?? false,
      }
    : {
        id: 'preview',
        name: '预览',
        protocol: 'openai' as const,
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'preview',
        modelId: 'preview',
        supportsImages: false,
      };
}
