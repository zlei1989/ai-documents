'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, Input } from '@aidocs/ui';
import { api } from '../_lib/settings-api';
import { errorMessage, useLoader } from '../_lib/use-loader';
import { Dialog, Field, InlineError, InlineHint, Select, Spinner } from './primitives';
import { useToast } from './toast';

interface CreateForm {
  name: string;
  description: string;
  /** '' = 空白新建；否则为来源类型名（整目录复制） */
  copyFrom: string;
}

const EMPTY_FORM: CreateForm = { name: '', description: '', copyFrom: '' };

/** 与后端 assertValidName 的前端预检：只挡最常见的错，最终以后端为准 */
function nameProblem(name: string): string {
  if (!name) return '类型名不能为空';
  if (name !== name.trim()) return '类型名首尾不能有空白';
  if (/[/\\\u0000-\u001f]/.test(name)) return '类型名不能包含路径分隔符或控制字符';
  if (name === '.' || name === '..') return '类型名不合法';
  if (name.startsWith('.')) return '类型名不能以 . 开头';
  if (name.length > 80) return '类型名最多 80 字';
  return '';
}

export function TypesTab() {
  const toast = useToast();
  const types = useLoader(api.listTypes);
  const [form, setForm] = useState<CreateForm | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const names = (types.data ?? []).map((type) => type.name);

  function openCreate(copyFrom?: string) {
    setFormError('');
    setForm(
      copyFrom
        ? { name: copyFrom.length > 76 ? copyFrom : `${copyFrom}-副本`, description: '', copyFrom }
        : { ...EMPTY_FORM },
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    const problem = nameProblem(form.name);
    if (problem) {
      setFormError(problem);
      return;
    }
    if (names.includes(form.name)) {
      setFormError(`类型「${form.name}」已存在`);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.createType({
        name: form.name,
        description: form.description.trim() || undefined,
        copyFrom: form.copyFrom || undefined,
      });
      toast.success(form.copyFrom ? `已复制「${form.copyFrom}」→「${form.name}」` : `已新建类型「${form.name}」`);
      setForm(null);
      await types.reload();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.deleteType(removeTarget);
      toast.success(`已删除类型「${removeTarget}」（软删到 .trash/types/，可手动找回）`);
      setRemoveTarget(null);
      await types.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="justify-between">
          <div>
            <div className="text-sm font-medium">类型</div>
            <div className="text-[11px] text-zinc-400">
              决定这一类文档的提示词模板、技能 / MCP 勾选与资源；新建文档时必须选一个
            </div>
          </div>
          <Button onClick={() => openCreate()}>新建类型</Button>
        </CardHeader>
        <CardContent className="p-0">
          {types.error ? (
            <div className="space-y-2 p-4">
              <InlineError message={types.error} />
              <Button variant="outline" onClick={() => void types.reload()}>
                重试
              </Button>
            </div>
          ) : null}
          {types.loading && !types.data ? (
            <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
              <Spinner /> 加载类型…
            </div>
          ) : (types.data?.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-zinc-500">
              还没有类型。新建一个空白类型后编辑提示词，或从现有类型整目录复制一份再改。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                    <th className="px-4 py-2 font-normal">名称</th>
                    <th className="px-4 py-2 font-normal">描述</th>
                    <th className="px-4 py-2 font-normal">规模</th>
                    <th className="px-4 py-2 font-normal">锁定模型</th>
                    <th className="px-4 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(types.data ?? []).map((type) => (
                    <tr key={type.name} className="border-b border-zinc-50 align-top last:border-0">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/types/${encodeURIComponent(type.name)}`}
                            className="font-medium hover:underline"
                          >
                            {type.name}
                          </Link>
                          {!type.manifest ? <Badge className="bg-amber-50 text-amber-700">清单异常</Badge> : null}
                        </div>
                      </td>
                      <td className="max-w-[260px] px-4 py-2">
                        <div className="truncate text-xs text-zinc-500" title={type.description || undefined}>
                          {type.description || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-600">
                        {type.manifest
                          ? `${type.manifest.skills.length} 技能 · ${type.manifest.mcp.length} MCP · ${type.resourceCount} 资源`
                          : `${type.resourceCount} 资源`}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-600">
                        {type.manifest?.model ? <Badge>{type.manifest.model}</Badge> : '—'}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-0.5">
                          <Link href={`/types/${encodeURIComponent(type.name)}`}>
                            <Button variant="ghost">编辑</Button>
                          </Link>
                          <Button variant="ghost" onClick={() => openCreate(type.name)}>
                            复制
                          </Button>
                          <Button
                            variant="ghost"
                            className="text-red-600"
                            onClick={() => setRemoveTarget(type.name)}
                          >
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={form !== null}
        title={form?.copyFrom ? `复制类型 · ${form.copyFrom} → 新类型` : '新建类型'}
        description="目录名即类型 id，可用中文；创建后进入类型编辑器写提示词"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button type="submit" form="type-form" disabled={saving}>
              {saving ? '创建中…' : form?.copyFrom ? '复制' : '创建'}
            </Button>
          </>
        }
      >
        {form ? (
          <form id="type-form" className="space-y-3" onSubmit={(event) => void submit(event)}>
            <Field label="来源" hint="复制会整目录拷贝 type.yaml / prompt.md / resources">
              <Select
                value={form.copyFrom}
                onChange={(copyFrom) => setForm({ ...form, copyFrom })}
                options={[{ value: '', label: '空白新建' }, ...names.map((name) => ({ value: name, label: `复制「${name}」` }))]}
              />
            </Field>
            <Field label="类型名（目录名，可用中文）">
              <Input
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="如：技术方案"
              />
            </Field>
            <Field label="描述" hint={form.copyFrom ? '复制时会被新描述覆盖，留空则沿用来源描述' : '一句话说明这类文档写给谁、解决什么'}>
              <Input
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="如：教模型写可评审的技术方案"
              />
            </Field>
            <InlineError message={formError} />
            <InlineHint>类型名不能含 / \\ 或控制字符，不能以 . 开头，最多 80 字。</InlineHint>
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        title={`删除类型 · ${removeTarget ?? ''}`}
        description="不会真删：目录移到 .trash/types/ 并加时间戳"
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={removing}>
              {removing ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-600">
          删除后，引用该类型的文档仍保留原 type 字段，但再打开编辑器会 404；进行中的会话下一轮生效。
          需要找回时到存储目录的 <code className="font-mono text-xs">.trash/types/</code> 改回目录名即可。
        </p>
      </Dialog>
    </div>
  );
}
