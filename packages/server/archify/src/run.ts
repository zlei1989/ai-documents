import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ArchifyDiagnostic, ArchifyType } from '@aidocs/contracts';
import type { ArchifyLayoutReceipt } from './layout';
import { ArchifyError, type ArchifyQuality, type ArchifyValidation } from './types';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const here = dirname(fileURLToPath(import.meta.url));

/** vendor 的 Archify skill 根目录；AIDOCS_ARCHIFY_ROOT 可覆盖为外部安装版本 */
export function archifyRoot(): string {
  const override = process.env.AIDOCS_ARCHIFY_ROOT?.trim();
  return resolve(override || join(here, '..', 'vendor', 'archify'));
}

export function assertArchifyAvailable(): string {
  const root = archifyRoot();
  const bin = join(root, 'bin', 'archify.mjs');
  if (!existsSync(bin)) {
    throw new ArchifyError(
      `Archify 引擎不可用：找不到 ${bin}。请确认 vendor 已安装，或设置 AIDOCS_ARCHIFY_ROOT。`,
      { stage: 'offline' },
    );
  }
  return root;
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARCHIFY_UPDATE_CHECK_DISABLED: '1',
    ARCHIFY_DIAGNOSTIC_FORMAT: 'json',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function asDiagnostics(value: unknown): ArchifyDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      code: typeof item.code === 'string' ? item.code : 'archify/unknown',
      severity: item.severity === 'warning' ? 'warning' : 'error',
      message: typeof item.message === 'string' ? item.message : 'Archify 校验失败',
      subject: (item.subject && typeof item.subject === 'object' ? item.subject : {}) as Record<string, unknown>,
      evidence: (item.evidence && typeof item.evidence === 'object' ? item.evidence : {}) as Record<string, unknown>,
      supportedFixes: Array.isArray(item.supportedFixes)
        ? item.supportedFixes.filter((fix): fix is string => typeof fix === 'string')
        : [],
    }));
}

function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 只校验，不写 HTML；返回 Archify 的 diagnostics */
export async function validateArchify(
  type: ArchifyType,
  inputPath: string,
  quality: ArchifyQuality,
  cwd: string,
  options: { layout?: boolean } = {},
): Promise<ArchifyValidation> {
  const withLayout = options.layout !== false && (type === 'architecture' || type === 'workflow');
  const root = assertArchifyAvailable();
  const bin = join(root, 'bin', 'archify.mjs');
  let stdout = '';
  let stderr = '';
  let execFailed = false;
  try {
    const result = await execFileAsync(
      process.execPath,
      [bin, 'validate', type, inputPath, '--json', '--quality', quality, ...(withLayout ? ['--layout-json'] : [])],
      { cwd, env: cliEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    execFailed = true;
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? failure.message ?? '';
  }
  const parsed = parseJsonOutput(stdout);
  if (!parsed) {
    throw new ArchifyError(`Archify 校验输出无法解析：${stderr.slice(0, 500) || '空输出'}`, {
      stage: 'validate',
    });
  }
  const diagnostics = asDiagnostics(parsed.diagnostics);
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((warning): warning is string => typeof warning === 'string')
    : stderr.trim()
      ? [stderr.trim().slice(0, 300)]
      : [];
  const layoutReceipt = withLayout ? (parsed as ArchifyLayoutReceipt) : undefined;
  // workflow 的 --layout-json 输出是 layout receipt，不带 ok 字段；用退出码 + 诊断推断。
  const hasErrorDiagnostic = diagnostics.some((item) => item.severity === 'error');
  const ok = parsed.ok === true || (parsed.ok === undefined && withLayout && !execFailed && !hasErrorDiagnostic);
  return { ok, diagnostics, warnings, ...(layoutReceipt ? { layoutReceipt } : {}) };
}

/** 渲染 HTML；失败抛出包含 stderr 的 ArchifyError */
export async function renderArchify(
  type: ArchifyType,
  inputPath: string,
  outputPath: string,
  quality: ArchifyQuality,
  cwd: string,
): Promise<void> {
  const root = assertArchifyAvailable();
  const bin = join(root, 'bin', 'archify.mjs');
  try {
    await execFileAsync(process.execPath, [bin, 'render', type, inputPath, outputPath, '--quality', quality], {
      cwd,
      env: cliEnv(),
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const detail = (failure.stderr || failure.stdout || failure.message || '').slice(0, 800);
    throw new ArchifyError(`Archify 渲染失败：${detail || '未知错误'}`, { stage: 'render' });
  }
  if (!existsSync(outputPath)) {
    throw new ArchifyError('Archify 渲染结束但没有生成 HTML 文件', { stage: 'render' });
  }
}
