import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillRef } from '@aidocs/contracts';

/** 扫描技能目录第一层：<dir>/<name>/SKILL.md + frontmatter */
export function scanSkills(dir: string, origin: 'personal' | 'project'): SkillRef[] {
  if (!existsSync(dir)) return [];
  const out: SkillRef[] = [];
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const file = join(skillDir, 'SKILL.md');
    if (!existsSync(file)) {
      out.push({ name: entry, description: '', dir: skillDir, origin, enabled: true, invalidReason: '缺少 SKILL.md' });
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    // 兼容 Windows 编辑器写出的 CRLF frontmatter
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
    let meta: Record<string, unknown> = {};
    try {
      meta = (front ? parseYaml(front) : {}) ?? {};
    } catch {
      out.push({ name: entry, description: '', dir: skillDir, origin, enabled: true, invalidReason: 'frontmatter 解析失败' });
      continue;
    }
    const name = typeof meta.name === 'string' ? meta.name : entry;
    const description = typeof meta.description === 'string' ? meta.description : '';
    const invalidReason = name !== entry ? `name 与目录名不一致（${name}）` : undefined;
    out.push({ name, description, dir: skillDir, origin, enabled: true, ...(invalidReason ? { invalidReason } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
