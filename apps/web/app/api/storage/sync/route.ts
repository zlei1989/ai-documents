import { z } from 'zod';
import { GitSyncActionSchema } from '@aidocs/contracts';
import { syncStorage } from '@aidocs/api';
import { json, readSchema, route } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SyncBodySchema = z.object({ action: GitSyncActionSchema });

/** POST /api/storage/sync：拉取或推送 storageRoot；冲突时自动启动 pi 修复 */
export const POST = route(async (request) => {
  const { action } = await readSchema(request, SyncBodySchema);
  return json(await syncStorage(action));
});
