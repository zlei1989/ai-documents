import type { SkillRef } from '@aidocs/contracts';

/**
 * 输入框里的技能指令只需要这三项；由页面按全局启停过滤后注入，
 * 不把服务端的 dir/enabled 带进 UI 包。
 */
export type ChatSkill = Pick<SkillRef, 'name' | 'description' | 'origin'>;

/** `/` 或 `/skill:` 开头、还没输入空格的草稿；插入技能后会带一个空格，菜单随之关闭。 */
const SLASH_DRAFT = /^\/(?:skill:)?(\S*)$/i;

/**
 * 输入框是否正在写技能指令。
 * 返回 `/` 后面用于过滤的词（`/skill:` 前缀会被吃掉）；不是技能指令草稿时返回 null。
 */
export function slashSkillQuery(input: string): string | null {
  const match = SLASH_DRAFT.exec(input);
  return match ? (match[1] ?? '').toLowerCase() : null;
}

/** 按名字优先、描述兜底过滤；名字命中的排前面，保持原顺序不乱跳。 */
export function filterSkills(skills: ChatSkill[], query: string): ChatSkill[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return skills;
  return skills
    .map((skill, index) => {
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      const score =
        name === wanted ? 0 : name.startsWith(wanted) ? 1 : name.includes(wanted) ? 2 : description.includes(wanted) ? 3 : -1;
      return { skill, index, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.skill);
}

/** 选中技能后写回输入框的命令；尾随空格让用户直接接着写需求。 */
export function skillCommand(skill: ChatSkill): string {
  return `/skill:${skill.name} `;
}
