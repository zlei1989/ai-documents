import type { ArchifyAiInput, ArchifyAiResult, ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import { generateArchifyIr, type PiProviderInput } from '@aidocs/agents';
import { validateArchifyIr } from '@aidocs/archify';
import { readConfig } from '@aidocs/core';
import { pickProvider } from './chat';
import { resolveArtifact } from './diagrams';
import { ServiceError } from './service-error';

/** 最多两次模型调用：第一次按要求/诊断改，仍不合法再带新诊断修一次 */
const MAX_ATTEMPTS = 2;

function aiDiagnostic(message: string): ArchifyDiagnostic {
  return {
    code: 'archify/ai-output',
    severity: 'error',
    message,
    subject: {},
    evidence: {},
    supportedFixes: [],
  };
}

async function validate(
  artifactDir: string,
  type: ArchifyType,
  ir: Record<string, unknown>,
  quality: 'standard' | 'showcase',
): Promise<{ ok: boolean; diagnostics: ArchifyDiagnostic[] }> {
  try {
    const result = await validateArchifyIr(artifactDir, type, ir, quality);
    return { ok: result.ok, diagnostics: result.diagnostics as ArchifyDiagnostic[] };
  } catch (error) {
    return { ok: false, diagnostics: [aiDiagnostic(`模型返回的 IR 无法校验：${(error as Error).message}`)] };
  }
}

/**
 * 编辑器里的 AI 改图：只返回草稿，不写盘。
 * - edit：按 instruction 改；
 * - repair：按 diagnostics 修。
 * 模型输出会过一遍 Archify schema；还有错误就再修一次，之后如实返回诊断。
 */
export async function editArchifyWithAi(
  root: string,
  group: string,
  name: string,
  input: ArchifyAiInput,
  signal?: AbortSignal,
): Promise<ArchifyAiResult> {
  const artifact = resolveArtifact(root, group, name);
  if (Buffer.byteLength(JSON.stringify(input.ir), 'utf8') > 256 * 1024) {
    throw new ServiceError('VALIDATION', 'IR 过大（上限 256KB），请先精简再让 AI 修改');
  }
  const config = readConfig();
  const { provider, modelId } = pickProvider(config);
  const model = provider.models.find((item) => item.id === modelId) ?? provider.models[0]!;
  const piProvider: PiProviderInput = {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId: model.id,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    supportsImages: model.supportsImages ?? false,
  };

  let current = input.ir;
  let summary = '';
  let modelName = `${provider.name}/${model.id}`;
  let diagnostics: ArchifyDiagnostic[] = [...input.diagnostics];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const generated = await generateArchifyIr({
        provider: piProvider,
        type: input.type,
        ir: current,
        mode: attempt === 0 ? input.mode : 'repair',
        ...(input.instruction ? { instruction: input.instruction } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        ...(signal ? { signal } : {}),
      });
      current = generated.ir;
      summary = generated.summary;
      modelName = generated.model;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ServiceError('INTERNAL', `AI 改图失败：${(error as Error).message}`);
    }

    const checked = await validate(artifact.dir, input.type, current, input.quality);
    diagnostics = checked.diagnostics;
    if (checked.ok) {
      return { ir: current, summary, ok: true, diagnostics, model: modelName };
    }
  }

  return { ir: current, summary, ok: false, diagnostics, model: modelName };
}
