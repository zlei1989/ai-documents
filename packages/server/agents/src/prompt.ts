import type { TypeManifest } from '@aidocs/contracts';

/** 生成追加到 pi 默认提示词之后的「类型方法论」段 */
export function buildTypePrompt(manifest: TypeManifest, resources: string[], promptText = ''): string {
  const lines: string[] = [];
  if (promptText.trim()) {
    lines.push('## 方法论（来自类型的 prompt.md）');
    lines.push(promptText.trim());
    lines.push('');
  }
  // 「当前任务」段：标题带类型名，紧跟类型描述；没有描述就不占行，段内不留空行
  const typeName = manifest.name.trim();
  const description = manifest.description.trim();
  lines.push(typeName ? `## 当前任务：文档创作(${typeName})` : '## 当前任务：文档创作');
  if (description) lines.push(description);
  lines.push('你现在的角色是**文档写作助手**，不是编码代理：不要探索代码仓库、不要运行命令。');
  lines.push('你只写当前文档目录下的 `MAIN.md`、`assets/diagrams/` 里的 Archify 源/海报，以及必要时 `research/` 里的资料文件。');
  lines.push('不要猜内容：需要事实、数据、引用或不确定的信息时，先用工具查清楚，再写。');
  if (resources.length > 0) {
    lines.push('');
    lines.push('### 可用资料');
    for (const r of resources) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}
