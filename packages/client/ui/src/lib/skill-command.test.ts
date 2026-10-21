import { describe, expect, it } from 'vitest';
import { filterSkills, skillCommand, slashSkillQuery, type ChatSkill } from './skill-command';

const skills: ChatSkill[] = [
  { name: 'code-review', description: 'Review changes against a base branch', origin: 'personal' },
  { name: 'codebase-design', description: 'Shared vocabulary for deep modules', origin: 'project' },
  { name: 'improve-codebase-architecture', description: 'Find deepening opportunities', origin: 'personal' },
  { name: 'tdd', description: 'Test-driven development and red-green-refactor', origin: 'personal' },
];

describe('slashSkillQuery', () => {
  it('首字符 / 才进入技能指令草稿', () => {
    expect(slashSkillQuery('/')).toBe('');
    expect(slashSkillQuery('/code')).toBe('code');
    expect(slashSkillQuery('/COD')).toBe('cod');
    expect(slashSkillQuery('帮我 /code')).toBeNull();
    expect(slashSkillQuery('')).toBeNull();
    expect(slashSkillQuery('你好')).toBeNull();
  });

  it('吃掉可选的 skill: 前缀，方便直接输入 /skill:名称', () => {
    expect(slashSkillQuery('/skill:')).toBe('');
    expect(slashSkillQuery('/skill:code')).toBe('code');
    expect(slashSkillQuery('/SKILL:code')).toBe('code');
  });

  it('插入技能后带了空格就不再是草稿', () => {
    expect(slashSkillQuery('/skill:tdd ')).toBeNull();
    expect(slashSkillQuery('/tdd 写测试')).toBeNull();
  });
});

describe('filterSkills', () => {
  it('空查询返回原列表', () => {
    expect(filterSkills(skills, '')).toBe(skills);
  });

  it('名字命中优先于描述命中，名字前缀又优先于包含', () => {
    expect(filterSkills(skills, 'code').map((skill) => skill.name)).toEqual([
      'code-review',
      'codebase-design',
      'improve-codebase-architecture',
    ]);
  });

  it('描述也能搜到，大小写不敏感', () => {
    expect(filterSkills(skills, 'RED-GREEN').map((skill) => skill.name)).toEqual(['tdd']);
    expect(filterSkills(skills, 'DEEP MODULES').map((skill) => skill.name)).toEqual(['codebase-design']);
    expect(filterSkills(skills, 'nothing-here')).toEqual([]);
  });
});

describe('skillCommand', () => {
  it('生成 pi 认识的 /skill: 指令并留一个空格', () => {
    expect(skillCommand(skills[0]!)).toBe('/skill:code-review ');
  });
});
