import { ProviderInputSchema } from '@aidocs/contracts';
import { ServiceError, deleteProvider, listProviders, saveProvider } from '@aidocs/api';
import { json, readKey, readSchema, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route(async () => json(listProviders()));

export const POST = route(async (request) =>
  json(saveProvider(await readSchema(request, ProviderInputSchema)), 201),
);

export const PUT = route(async (request) => {
  const input = await readSchema(request, ProviderInputSchema);
  if (!input.id) throw new ServiceError('VALIDATION', '缺少供应商 id');
  return json(saveProvider(input));
});

export const DELETE = route(async (request) => {
  deleteProvider(await readKey(request, 'id'));
  return json({ ok: true });
});
