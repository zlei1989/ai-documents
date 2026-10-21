import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '@aidocs/core';
import {
  listSkills,
  listUsableSkills,
  parseSkillCommand,
  readSkillContent,
  resolveSkillCommand,
  resolveSkillInvocation,
  setSkillEnabled,
} from './skills';
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

  it('可显式调用的技能只留启用且合格的，同名只留第一个来源', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));
    writeSkill(personal.dir, 'mismatch', skillMd('别的名字', '名字不一致'));
    mkdirSync(join(personal.dir, 'empty'));
    setStorageRoot(storageDir);
    writeSkill(join(storageDir, 'skills'), 'alpha', skillMd('alpha', '项目同名'));
    writeSkill(join(storageDir, 'skills'), 'beta', skillMd('beta', '项目技能'));

    expect(listUsableSkills().map((skill) => skill.name)).toEqual(['alpha', 'beta']);
    expect(listUsableSkills().find((skill) => skill.name === 'alpha')?.origin).toBe('personal');

    setSkillEnabled('beta', false);
    expect(listUsableSkills().map((skill) => skill.name)).toEqual(['alpha']);
  });

  it('解析 /skill: 命令：摘出技能名与剩余需求，其它斜杠文本不动', () => {
    expect(parseSkillCommand('/skill:tdd')).toEqual({ name: 'tdd', rest: '' });
    expect(parseSkillCommand('/skill:tdd 写测试')).toEqual({ name: 'tdd', rest: '写测试' });
    expect(parseSkillCommand('/skill:tdd\n第一行\n第二行')).toEqual({ name: 'tdd', rest: '第一行\n第二行' });
    expect(parseSkillCommand('/tdd 写测试')).toBeNull();
    expect(parseSkillCommand('请用 /skill:tdd')).toBeNull();
  });

  it('技能调用读出正文并去掉 frontmatter；未知/停用/不合格都有明确错误', () => {
    const file = writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));

    const invocation = resolveSkillInvocation('alpha');
    expect(invocation).toMatchObject({
      name: 'alpha',
      file,
      baseDir: join(personal.dir, 'alpha'),
    });
    expect(invocation.body).toContain('# alpha');
    expect(invocation.body).not.toContain('---');

    expect(codeOf(() => resolveSkillInvocation('missing'))).toBe('NOT_FOUND');

    writeSkill(personal.dir, 'mismatch', skillMd('别的名字', '名字不一致'));
    expect(codeOf(() => resolveSkillInvocation('别的名字'))).toBe('VALIDATION');

    setSkillEnabled('alpha', false);
    expect(codeOf(() => resolveSkillInvocation('alpha'))).toBe('VALIDATION');
  });

  it('sendMessage 前的拆解：技能块与用户需求分开，普通消息原样返回', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));
    const allowed = new Set(['alpha']);

    const hit = resolveSkillCommand('/skill:alpha 画一张图', allowed);
    expect(hit.text).toBe('画一张图');
    expect(hit.titleText).toBe('画一张图');
    expect(hit.skill?.name).toBe('alpha');
    expect(hit.skill?.body).toContain('# alpha');

    // 只有命令时用技能名当标题，标题不会是一串 /skill:
    const bare = resolveSkillCommand('/skill:alpha', allowed);
    expect(bare.text).toBe('');
    expect(bare.titleText).toBe('alpha');

    // 手输 /技能名 的简写也认，但没命中技能时保持普通文本
    expect(resolveSkillCommand('/alpha 画图', allowed)).toMatchObject({
      text: '画图',
      titleText: '画图',
      skill: { name: 'alpha' },
    });
    expect(resolveSkillCommand('/tmp/foo 看看', allowed)).toEqual({ text: '/tmp/foo 看看', titleText: '/tmp/foo 看看' });

    expect(resolveSkillCommand('普通消息', allowed)).toEqual({ text: '普通消息', titleText: '普通消息' });
  });

  it('只认当前类型勾选的技能：类型外的显式命令报错，简写当普通文本', () => {
    writeSkill(personal.dir, 'alpha', skillMd('alpha', '个人技能'));
    writeSkill(personal.dir, 'beta', skillMd('beta', '另一个技能'));
    const allowed = new Set(['alpha']);

    // beta 全局可用但没被类型勾选：显式点名给出可操作的错误
    expect(codeOf(() => resolveSkillCommand('/skill:beta 做点什么', allowed))).toBe('VALIDATION');

    // 简写不报错，避免普通斜杠文本被误吞，只是不触发技能
    expect(resolveSkillCommand('/beta 做点什么', allowed)).toEqual({
      text: '/beta 做点什么',
      titleText: '/beta 做点什么',
    });

    // 类型勾选但全局停用：解析阶段就拦下
    setSkillEnabled('alpha', false);
    expect(codeOf(() => resolveSkillCommand('/skill:alpha 画图', allowed))).toBe('VALIDATION');
  });
});
