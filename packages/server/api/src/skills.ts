import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillContent, SkillRef } from '@aidocs/contracts';
import { assertInside, personalSkillsDir, projectSkillsDir, readConfig, scanSkills, updateConfig } from '@aidocs/core';
import { ServiceError } from './service-error';

/** 两个来源合并 + 全局停用（config.settings.disabledSkills）覆盖 */
export function listSkills(): SkillRef[] {
  const config = readConfig();
  const disabled = new Set(config.settings.disabledSkills);
  const personal = scanSkills(personalSkillsDir(), 'personal');
  const project = config.settings.storageRoot ? scanSkills(projectSkillsDir(config.settings.storageRoot), 'project') : [];
  return [...personal, ...project]
    .map((skill) => ({ ...skill, enabled: !disabled.has(skill.name) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
}

/** 按名字全局启停；停用优先于类型勾选（调用侧只读 enabled） */
export function setSkillEnabled(name: string, enabled: boolean): SkillRef[] {
  if (!listSkills().some((skill) => skill.name === name)) {
    throw new ServiceError('NOT_FOUND', `技能不存在：${name}`);
  }
  updateConfig((config) => {
    const disabled = new Set(config.settings.disabledSkills);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    config.settings.disabledSkills = [...disabled].sort();
  });
  return listSkills();
}

/** 读取 SKILL.md 原文（预览抽屉）；只允许命中扫描结果，杜绝路径穿越 */
export function readSkillContent(name: string, origin: 'personal' | 'project'): SkillContent {
  const config = readConfig();
  let root: string;
  if (origin === 'personal') {
    root = personalSkillsDir();
  } else {
    if (!config.settings.storageRoot) throw new ServiceError('VALIDATION', '尚未选择存储目录');
    root = projectSkillsDir(config.settings.storageRoot);
  }
  try {
    assertInside(root, join(root, name));
  } catch {
    throw new ServiceError('VALIDATION', `技能路径越界：${name}`);
  }
  const hit = scanSkills(root, origin).find((skill) => skill.name === name);
  if (!hit) throw new ServiceError('NOT_FOUND', `技能不存在：${name}`);
  const file = join(hit.dir, 'SKILL.md');
  if (!existsSync(file)) throw new ServiceError('NOT_FOUND', `缺少 SKILL.md：${name}`);
  return { name, origin, content: readFileSync(file, 'utf8') };
}
