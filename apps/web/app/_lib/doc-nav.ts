/**
 * 文档 ⇄ 类型编辑器的往返地址。
 *
 * 约定：从文档进入类型编辑器时带 `?doc=<group>/<name>`；类型编辑器据此
 * 生成可直达的「回到文档」地址，而不是依赖 `router.back()`（新标签页、
 * 刷新、从设置页进入时都没有可回退的历史）。
 */

/** 把 ?doc=group/name 解析成创作页地址；格式不合法时返回 null */
export function docToWorkspaceHref(doc: string | undefined | null): string | null {
  if (!doc) return null;
  const parts = doc.split('/');
  if (parts.length !== 2) return null;
  const [group, name] = parts;
  if (!group || !name) return null;
  return `/workspace/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
}

/** 类型编辑器地址；带文档上下文时把 ?doc 原样带上，供「回到文档」使用 */
export function typeEditorHref(typeName: string, doc?: string | null): string {
  const base = `/types/${encodeURIComponent(typeName)}`;
  const workspace = docToWorkspaceHref(doc);
  return workspace && doc ? `${base}?doc=${encodeURIComponent(doc)}` : base;
}
