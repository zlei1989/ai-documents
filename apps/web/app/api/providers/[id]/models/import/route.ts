import { ModelImportInputSchema } from '@aidocs/contracts';
import { importModels } from '@aidocs/api';
import { json, readSchema, route, type RouteContext } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route<RouteContext<{ id: string }>>(async (request, context) => {
  const { id } = await context.params;
  const { models } = await readSchema(request, ModelImportInputSchema);
  return json(importModels(id, models));
});
