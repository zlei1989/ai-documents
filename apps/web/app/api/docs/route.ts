import { z } from 'zod';
import { createDoc, listDocs, resolveStorageRoot } from '@aidocs/api';
import { readJson, route, validate } from '../_lib/http';

export const dynamic = 'force-dynamic';

const CreateDocBody = z.object({
  group: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  title: z.string().optional(),
});

/** GET /api/docs：文档列表（Group → Artifact） */
export async function GET() {
  return route(() => listDocs(resolveStorageRoot()))();
}

/** POST /api/docs：新建文档（目录 + meta.yaml + MAIN.md），仓库内提交一次 */
export async function POST(request: Request) {
  return route(async () => {
    const body = validate(CreateDocBody, await readJson(request));
    return createDoc(resolveStorageRoot(), body);
  })();
}
