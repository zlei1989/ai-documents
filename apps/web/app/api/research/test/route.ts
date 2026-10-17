import { ResearchTestInputSchema } from '@aidocs/contracts';
import { testResearch } from '@aidocs/api';
import { json, readJson, route, validate } from '../../_lib/http';

export const dynamic = 'force-dynamic';

/** POST /api/research/test：用保存的（或表单里正在编辑的）供应商 key 真打一次 Search */
export const POST = route(async (request) => {
  const raw = await readJson(request).catch(() => ({}));
  const input = validate(ResearchTestInputSchema, raw ?? {});
  return json(await testResearch(input));
});
