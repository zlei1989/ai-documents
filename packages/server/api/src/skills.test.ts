import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '@aidocs/core';
import { listSkills, readSkillContent, setSkillEnabled } from './skills';
import { setStorageRoot } from './storage';
import { ServiceError } from './service-error';
import { isolateConfigDir, isolatePersonalSkillsDir } from './test-utils';

let env: ReturnType<typeof isolateConfigDir>;
let personal: ReturnType<typeof isolatePersonalSkillsDir>;
let storageDir: string;

beforeEach(() => {
  env = isolateConfigDir();
  personal = isolatePersonalSkillsDir();
  storageDir = mkdtempSync(join(tmpdir(), 'aidocs-project-'));
});
afterEach(() => {
  env.restore();
  personal.restore();
  rmSync(storageDir, { recursive: true, force: true });
});

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文内容。\n`;
}

function writeSkill(root: string, dir: string, content: string): string {
  mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, dir, 'SKILL.md');
  writeFileSync(file, content, 'utf8');
  return file;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  throw new Error('期望抛出 ServiceError，但没有抛错');
}

describe('Skills', () => {
  it('合并个人与项目两个来源，并标出不合格条目', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));
    writeSkill(personal.dir, 'mismatch', skillMd('别的名字', '名字不一致'));
    mkdirSync(join(personal.dir, 'empty'));
    setStorageRoot(storageDir);
    writeSkill(join(storageDir, 'skills'), 'beta', skillMd('beta', '项目技能'));

    const skills = listSkills();

    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'empty', '别的名字']);
    expect(skills.find((s) => s.name === 'alpha')).toMatchObject({ origin: 'personal', enabled: true, description: '个人技能' });
    expect(skills.find((s) => s.name === 'beta')).toMatchObject({ origin: 'project', enabled: true });
    expect(skills.find((s) => s.name === 'empty')?.invalidReason).toContain('缺少 SKILL.md');
    expect(skills.find((s) => s.name === '别的名字')?.invalidReason).toContain('name 与目录名不一致');
  });

  it('未选择存储目录时只有个人来源，项目来源不出错', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));
    expect(listSkills().map((s) => s.name)).toEqual(['alpha']);
  });

  it('停用写入 config.settings.disabledSkills，再启用则移除', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));

    const disabled = setSkillEnabled('alpha', false);
    expect(disabled.find((s) => s.name === 'alpha')?.enabled).toBe(false);
    expect(readConfig().settings.disabledSkills).toEqual(['alpha']);

    const enabled = setSkillEnabled('alpha', true);
    expect(enabled.find((s) => s.name === 'alpha')?.enabled).toBe(true);
    expect(readConfig().settings.disabledSkills).toEqual([]);
  });

  it('同名技能按名字全局停用（两个来源一起停）', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人'));
    setStorageRoot(storageDir);
    writeSkill(join(storageDir, 'skills'), 'alpha', skillMd('alpha', '项目'));

    const skills = setSkillEnabled('alpha', false);
    expect(skills.filter((s) => s.name === 'alpha').every((s) => !s.enabled)).toBe(true);
  });

  it('停用不存在的技能给 NOT_FOUND', () => {
    expect(codeOf(() => setSkillEnabled('missing', false))).toBe('NOT_FOUND');
  });

  it('读取 SKILL.md 原文：未知技能与路径穿越都拒绝', () => {
    const file = writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));

    const content = readSkillContent('alpha', 'personal');
    expect(content.name).toBe('alpha');
    expect(content.origin).toBe('personal');
    expect(content.content).toBe(readFileSync(file, 'utf8'));

    expect(codeOf(() => readSkillContent('missing', 'personal'))).toBe('NOT_FOUND');
    expect(codeOf(() => readSkillContent('../alpha', 'personal'))).toBe('VALIDATION');
    expect(codeOf(() => readSkillContent('alpha', 'project'))).toBe('VALIDATION');
  });
});
