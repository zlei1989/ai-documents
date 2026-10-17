import { ArchifyValidateInputSchema } from '@aidocs/contracts';
import { resolveStorageRoot, validateArchifyDocument } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** POST：只校验 Archify IR，不写盘；供编辑器「校验」按钮 */
export async function POST(request: Request, context: Context) {
  return route<Context>(async () => {
    const { group, name } = await context.params;
    const body = validate(ArchifyValidateInputSchema, await readJson(request));
    return validateArchifyDocument(resolveStorageRoot(), group, name, body.type, body.ir, body.quality);
  })();
}
