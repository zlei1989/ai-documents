import { previewModels } from '@aidocs/api';
import { json, route, type RouteContext } from '../../../../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route<RouteContext<{ id: string }>>(async (_request, context) => {
  const { id } = await context.params;
  return json(await previewModels(id));
});
