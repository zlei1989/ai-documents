import { describe, expect, it } from 'vitest';
import { buildFollowUpPrompt, buildRepairPrompt, hasConflictMarkers } from './git-repair';

describe('冲突修复提示词与标记检测', () => {
  it('识别行首冲突标记，不误判 Markdown 分隔线', () => {
    expect(
      hasConflictMarkers(['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> origin/main'].join('\n')),
    ).toBe(true);
    expect(hasConflictMarkers('标题\n=======\n正文\n')).toBe(false);
    expect(hasConflictMarkers('正常内容\n')).toBe(false);
  });

  it('二进制/NUL 内容按无法自动处理对待', () => {
    expect(hasConflictMarkers('a\0b')).toBe(true);
  });

  it('两个提示词都带完整文件清单', () => {
    const files = ['docs/JW/智能网关/MAIN.md', 'docs/JW/智能网关/meta.yaml'];
    const first = buildRepairPrompt(files);
    expect(first).toContain('git 冲突修复');
    for (const file of files) expect(first).toContain(file);

    const followUp = buildFollowUpPrompt(files);
    for (const file of files) expect(followUp).toContain(file);
    expect(followUp).toContain('冲突标记');
  });
});
