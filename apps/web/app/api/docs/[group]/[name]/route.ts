import { z } from 'zod';
import { deleteDoc, getDoc, renameDoc, resolveStorageRoot, saveMain } from '@aidocs/api';
import { readJson, route, validate } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

const UpdateDocBody = z.object({
  main: z.string().optional(),
  name: z.string().min(1).optional(),
});

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** GET /api/docs/<group>/<name>：meta.yaml + MAIN.md */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    return getDoc(resolveStorageRoot(), group, name);
  })();
}

/** PUT /api/docs/<group>/<name>：保存正文（main）或重命名（name） */
export async function PUT(request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    const root = resolveStorageRoot();
    const body = validate(UpdateDocBody, await readJson(request));
    let target = { group, name };
    if (body.name !== undefined && body.name !== name) {
      const renamed = renameDoc(root, group, name, body.name);
      target = { group: renamed.group, name: renamed.name };
    }
    if (body.main !== undefined) {
      return saveMain(root, target.group, target.name, body.main);
    }
    return getDoc(root, target.group, target.name);
  })();
}

/** DELETE /api/docs/<group>/<name>：直接删除目录（git 历史里留删除提交，可恢复） */
export async function DELETE(_request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    deleteDoc(resolveStorageRoot(), group, name);
    return { ok: true };
  })();
}
