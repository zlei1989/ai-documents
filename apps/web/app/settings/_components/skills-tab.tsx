'use client';
import { useEffect, useState } from 'react';
import type { SkillRef } from '@aidocs/contracts';
import { Badge, Button, Card, CardContent, CardHeader, Checkbox, cn } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { Drawer, InlineError, Spinner } from './primitives';
import { useToast } from './toast';

export function SkillsTab() {
  const toast = useToast();
  const skills = useLoader(api.listSkills);
  const [active, setActive] = useState<SkillRef | null>(null);
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setContent('');
    setContentError('');
    setLoadingContent(true);
    api
      .skillContent(active.name, active.origin)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch((error) => {
        if (!cancelled) setContentError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function toggle(skill: SkillRef, enabled: boolean) {
    setToggling(skill.name);
    try {
      await api.toggleSkill(skill.name, enabled);
      toast.success(enabled ? `已启用 ${skill.name}` : `已停用 ${skill.name}（全局停用优先于类型勾选）`);
      await skills.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setToggling(null);
    }
  }

  const list = skills.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">Skills（全局）</div>
            <div className="text-[11px] text-zinc-400">
              两个来源：<code>~/.agents/skills</code>（个人）与 <code>&lt;storageRoot&gt;/skills</code>（项目，随 git）
            </div>
          </div>
          <Button variant="outline" onClick={() => void skills.reload()} disabled={skills.loading}>
            {skills.loading ? '刷新中…' : '刷新'}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <InlineError message={skills.error} />
          {skills.loading && !skills.data ? (
            <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
              <Spinner /> 扫描技能目录…
            </div>
          ) : list.length === 0 ? (
            <div className="space-y-2 p-4 text-sm text-zinc-500">
              <p>还没有发现技能。</p>
              <p className="text-xs text-zinc-400">
                个人技能放到 <code>~/.agents/skills/&lt;name&gt;/SKILL.md</code>；项目技能放到
                <code> &lt;storageRoot&gt;/skills/&lt;name&gt;/SKILL.md</code>（frontmatter 需 name + description）。
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                    <th className="px-4 py-2 font-normal">名称</th>
                    <th className="px-4 py-2 font-normal">描述</th>
                    <th className="px-4 py-2 font-normal">来源</th>
                    <th className="px-4 py-2 font-normal">状态</th>
                    <th className="px-4 py-2 text-right font-normal">启用</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((skill) => (
                    <tr
                      key={`${skill.origin}/${skill.name}`}
                      className={cn('border-b border-zinc-50 last:border-0', !skill.enabled && 'opacity-60')}
                    >
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setActive(skill)}
                          className="text-left font-medium text-zinc-800 hover:underline"
                        >
                          {skill.name}
                        </button>
                      </td>
                      <td className="max-w-[320px] px-4 py-2">
                        <span className="line-clamp-2 text-xs text-zinc-600">{skill.description || '—'}</span>
                      </td>
                      <td className="px-4 py-2">
                        <Badge className={skill.origin === 'project' ? 'bg-sky-50 text-sky-700' : undefined}>
                          {skill.origin === 'project' ? '项目' : '个人'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        {skill.invalidReason ? (
                          <span className="text-[11px] text-amber-600">不合格：{skill.invalidReason}</span>
                        ) : skill.enabled ? (
                          <span className="text-[11px] text-emerald-600">可用</span>
                        ) : (
                          <span className="text-[11px] text-zinc-400">全局停用</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-2">
                          {toggling === skill.name ? <Spinner /> : null}
                          <Checkbox
                            checked={skill.enabled}
                            disabled={Boolean(skill.invalidReason) || toggling === skill.name}
                            onChange={(event) => void toggle(skill, event.target.checked)}
                            aria-label={`${skill.name} 启停`}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-zinc-50 px-4 py-2 text-[11px] text-zinc-400">
            停用是全局的：即使类型里勾选了该技能，也不会注入。点技能名可预览 SKILL.md。
          </p>
        </CardContent>
      </Card>

      <Drawer
        open={active !== null}
        title={active?.name ?? ''}
        subtitle={active ? `${active.origin === 'project' ? '项目级' : '个人'} · ${active.dir}` : undefined}
        onClose={() => setActive(null)}
        footer={
          active ? (
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>SKILL.md</span>
              <span>{active.enabled ? '已启用' : '全局停用'}</span>
            </div>
          ) : null
        }
      >
        {loadingContent ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Spinner /> 读取 SKILL.md…
          </div>
        ) : contentError ? (
          <InlineError message={contentError} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-zinc-700">
            {content}
          </pre>
        )}
      </Drawer>
    </div>
  );
}
