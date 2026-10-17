import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 测试专用：把应用配置目录指向一次性临时目录。
 * 服务层所有落盘都经 core/config-store，因此改环境变量即可隔离。
 */
export function isolateConfigDir(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aidocs-cfg-'));
  const prev = process.env.AIDOCS_CONFIG_DIR;
  process.env.AIDOCS_CONFIG_DIR = dir;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.AIDOCS_CONFIG_DIR;
      else process.env.AIDOCS_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 测试专用：把个人技能目录指向临时目录并顺带建好结构 */
export function isolatePersonalSkillsDir(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aidocs-skills-'));
  const prev = process.env.AIDOCS_PERSONAL_SKILLS_DIR;
  process.env.AIDOCS_PERSONAL_SKILLS_DIR = dir;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.AIDOCS_PERSONAL_SKILLS_DIR;
      else process.env.AIDOCS_PERSONAL_SKILLS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
