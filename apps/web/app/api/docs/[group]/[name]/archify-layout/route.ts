import { ArchifyLayoutInputSchema } from '@aidocs/contracts';
import { layoutArchifyDocument, resolveStorageRoot } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** POST：排版（architecture 摆位 / workflow 补卡片尺寸），只返回变换后的 IR，不写盘 */
export async function POST(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name } = await context.params;
    const body = validate(ArchifyLayoutInputSchema, await readJson(request));
    return layoutArchifyDocument(resolveStorageRoot(), group, name, body.type, body.ir);
  })();
}
