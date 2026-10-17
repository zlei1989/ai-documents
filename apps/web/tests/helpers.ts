import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 路由测试专用：把应用配置目录与个人技能目录指向临时目录 */
export function isolateEnv(): { configDir: string; skillsDir: string; restore: () => void } {
  const configDir = mkdtempSync(join(tmpdir(), 'aidocs-web-cfg-'));
  const skillsDir = mkdtempSync(join(tmpdir(), 'aidocs-web-skills-'));
  const prevConfig = process.env.AIDOCS_CONFIG_DIR;
  const prevSkills = process.env.AIDOCS_PERSONAL_SKILLS_DIR;
  process.env.AIDOCS_CONFIG_DIR = configDir;
  process.env.AIDOCS_PERSONAL_SKILLS_DIR = skillsDir;
  return {
    configDir,
    skillsDir,
    restore: () => {
      if (prevConfig === undefined) delete process.env.AIDOCS_CONFIG_DIR;
      else process.env.AIDOCS_CONFIG_DIR = prevConfig;
      if (prevSkills === undefined) delete process.env.AIDOCS_PERSONAL_SKILLS_DIR;
      else process.env.AIDOCS_PERSONAL_SKILLS_DIR = prevSkills;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(skillsDir, { recursive: true, force: true });
    },
  };
}

export function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
