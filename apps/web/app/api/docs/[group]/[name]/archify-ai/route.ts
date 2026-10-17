import { ArchifyAiInputSchema } from '@aidocs/contracts';
import { editArchifyWithAi, resolveStorageRoot } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** POST：直接调 pi 模型改/修 IR（结构化 JSON），只返回草稿，不写盘 */
export async function POST(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name } = await context.params;
    const body = validate(ArchifyAiInputSchema, await readJson(request));
    return editArchifyWithAi(resolveStorageRoot(), group, name, body, request.signal);
  })();
}
