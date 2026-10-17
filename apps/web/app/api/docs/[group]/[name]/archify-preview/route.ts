import { ArchifyPreviewInputSchema } from '@aidocs/contracts';
import { previewArchifyDocument, resolveStorageRoot } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** POST：把当前 IR 渲染到 .aidocs 预览缓存；不写源/海报/marker */
export async function POST(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name } = await context.params;
    const body = validate(ArchifyPreviewInputSchema, await readJson(request));
    return previewArchifyDocument(resolveStorageRoot(), group, name, body.type, body.ir, body.quality);
  })();
}
