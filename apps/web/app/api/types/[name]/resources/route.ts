import { z } from 'zod';
import {
  deleteResource,
  listResources,
  mkdirResource,
  renameResource,
  resolveStorageRoot,
} from '@aidocs/api';
import { readJson, route, validate } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

const ResourceActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mkdir'), path: z.string().min(1) }),
  z.object({ action: z.literal('rename'), path: z.string().min(1), to: z.string().min(1) }),
  z.object({ action: z.literal('delete'), path: z.string().min(1) }),
]);

interface Context {
  params: Promise<{ name: string }>;
}

/** GET /api/types/:name/resources：resources/ 目录树 */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    return listResources(resolveStorageRoot(), name);
  })();
}

/** POST /api/types/:name/resources：mkdir / rename / delete */
export async function POST(request: Request, context: Context) {
  return route(async () => {
    const { name } = await context.params;
    const root = resolveStorageRoot();
    const body = validate(ResourceActionBody, await readJson(request));
    switch (body.action) {
      case 'mkdir':
        mkdirResource(root, name, body.path);
        break;
      case 'rename':
        renameResource(root, name, body.path, body.to);
        break;
      case 'delete':
        deleteResource(root, name, body.path);
        break;
    }
    return listResources(root, name);
  })();
}
