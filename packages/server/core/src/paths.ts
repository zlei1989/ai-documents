import { homedir } from 'node:os';
import { join } from 'node:path';

/** 应用配置目录（含密钥，不属于 storageRoot） */
export function configDir(): string {
  return process.env.AIDOCS_CONFIG_DIR ?? join(homedir(), '.aidocs');
}

export function configFile(): string {
  return join(configDir(), 'config.json');
}

/** 个人全局技能目录（agentskills 规范） */
export function personalSkillsDir(): string {
  return process.env.AIDOCS_PERSONAL_SKILLS_DIR ?? join(homedir(), '.agents', 'skills');
}

/** 项目级技能目录（随 storageRoot git 走） */
export function projectSkillsDir(storageRoot: string): string {
  return join(storageRoot, 'skills');
}

export function typeDir(storageRoot: string, name: string): string {
  return join(storageRoot, 'types', name);
}

export function artifactDir(storageRoot: string, group: string, name: string): string {
  return join(storageRoot, 'docs', group, name);
}
