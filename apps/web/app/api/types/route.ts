import { z } from 'zod';
import { createType, listTypes, resolveStorageRoot } from '@aidocs/api';
import { readJson, route, validate } from '../_lib/http';

export const dynamic = 'force-dynamic';

const CreateTypeBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.string().nullable().optional(),
  copyFrom: z.string().optional(),
});

/** GET /api/types：类型列表（目录名即 id） */
export async function GET() {
  return route(() => listTypes(resolveStorageRoot()))();
}

/** POST /api/types：新建类型（空白或复制现有类型整目录） */
export async function POST(request: Request) {
  return route(async () => {
    const body = validate(CreateTypeBody, await readJson(request));
    return createType(resolveStorageRoot(), body);
  })();
}
