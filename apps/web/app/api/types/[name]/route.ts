import { z } from 'zod';
import { TypeManifestSchema } from '@aidocs/contracts';
import { deleteType, getType, resolveStorageRoot, saveType } from '@aidocs/api';
import { readJson, route, validate } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const SaveTypeBody = z.object({
  manifest: TypeManifestSchema.partial().optional(),
  prompt: z.string().optional(),
});

interface Context {
  params: Promise<{ name: string }>;
}

/** GET /api/types/:name：type.yaml + prompt.md */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    return getType(resolveStorageRoot(), name);
  })();
}

/** PUT /api/types/:name：保存清单与提示词（原子写） */
export async function PUT(request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    const body = validate(SaveTypeBody, await readJson(request));
    return saveType(resolveStorageRoot(), name, body);
  })();
}

/** DELETE /api/types/:name：软删到 .trash/types/ */
export async function DELETE(_request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    deleteType(resolveStorageRoot(), name);
    return { ok: true };
  })();
}
