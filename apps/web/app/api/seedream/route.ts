import { SeedreamPatchSchema } from '@aidocs/contracts';
import { getSeedreamView, saveSeedreamSettings } from '@aidocs/api';
import { json, readSchema, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

/** GET /api/seedream：配置视图（key 只回掩码） */
export const GET = route(async () => json(getSeedreamView()));

/** PUT /api/seedream：局部保存；apiKey 空 = 保持原值 */
export const PUT = route(async (request) =>
  json(saveSeedreamSettings(await readSchema(request, SeedreamPatchSchema))),
);
