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

/**
 * 用户能显式调用的技能：全局启用 + frontmatter 合格；同名技能只留扫描顺序里的第一个
 * （个人来源排在项目来源前，与 pi 的「先发现先赢」一致）。
 */
export function listUsableSkills(): SkillRef[] {
  const seen = new Set<string>();
  return listSkills().filter((skill) => {
    if (!skill.enabled || skill.invalidReason || seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
}

/** 显式 /skill:<name> 调用时要注入的 SKILL.md 正文 */
export interface SkillInvocation {
  name: string;
  /** SKILL.md 绝对路径，写进提示词让模型知道去哪里读附属文件 */
  file: string;
  /** 技能目录：正文里的相对引用以它为基准 */
  baseDir: string;
  /** 去掉 frontmatter 的正文 */
  body: string;
}

/** 消息开头的 /skill:<name>；返回技能名与后面的用户需求。 */
const SKILL_COMMAND = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/;

export function parseSkillCommand(text: string): { name: string; rest: string } | null {
  const match = SKILL_COMMAND.exec(text);
  if (!match) return null;
  return { name: match[1]!, rest: (match[2] ?? '').trim() };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function invocationOf(skill: SkillRef): SkillInvocation {
  const file = join(skill.dir, 'SKILL.md');
  return { name: skill.name, file, baseDir: skill.dir, body: stripFrontmatter(readFileSync(file, 'utf8')).trim() };
}

/**
 * 解析显式技能调用：只认扫描结果，杜绝路径穿越；停用/不合格的技能给出明确原因，
 * 不把 /skill: 原样漏给模型。
 */
export function resolveSkillInvocation(name: string): SkillInvocation {
  const skill = listSkills().find((item) => item.name === name);
  if (!skill) throw new ServiceError('NOT_FOUND', `技能不存在：${name}`);
  if (!skill.enabled) throw new ServiceError('VALIDATION', `技能已停用：${name}`);
  if (skill.invalidReason) throw new ServiceError('VALIDATION', `技能不可用：${skill.invalidReason}`);
  return invocationOf(skill);
}

/** sendMessage 前的拆解结果：命令从用户文本里摘掉，技能正文单独注入 */
export interface SkillCommandResolution {
  /** 去掉 /skill:<name> 之后的用户需求，作为发给模型的用户文本 */
  text: string;
  /** 会话标题：优先用户需求；只有命令时用技能名，避免标题是一串命令 */
  titleText: string;
  skill?: SkillInvocation;
}

/**
 * 普通消息原样返回；/skill:<name> 才解析技能，并把命令从文本里摘掉。
 * allowedSkills 是当前文档类型 type.yaml 勾选的技能：不在其中的既不会被简写命中，
 * 显式点名也会报错，避免绕过类型的技能白名单。
 */
export function resolveSkillCommand(text: string, allowedSkills: ReadonlySet<string>): SkillCommandResolution {
  const explicit = parseSkillCommand(text);
  if (explicit) {
    const skill = resolveSkillInvocation(explicit.name);
    if (!allowedSkills.has(skill.name)) {
      throw new ServiceError('VALIDATION', `技能不在当前类型里：${skill.name}（到「编辑类型 → 技能」勾选后可用）`);
    }
    return { text: explicit.rest, titleText: explicit.rest || skill.name, skill };
  }
  // 也认 /技能名 的简写（列表里插入的是 /skill:，但用户手输时常常省掉前缀）。
  // 只有命中「类型勾选 + 可用」的技能才当命令，避免把 /tmp/foo 这类普通文本吞掉。
  const shorthand = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!shorthand) return { text, titleText: text };
  const name = shorthand[1]!;
  const skill = listUsableSkills().find((item) => item.name === name);
  if (!skill || !allowedSkills.has(name)) return { text, titleText: text };
  const rest = (shorthand[2] ?? '').trim();
  return { text: rest, titleText: rest || name, skill: invocationOf(skill) };
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
