import { McpProbeInputSchema } from '@aidocs/contracts';
import { probeMcpServer, probeSavedMcpServer } from '@aidocs/api';
import { json, readSchema, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route(async (request) => {
  const input = await readSchema(request, McpProbeInputSchema);
  const result = 'server' in input ? await probeMcpServer(input.server) : await probeSavedMcpServer(input.name);
  return json(result);
});
