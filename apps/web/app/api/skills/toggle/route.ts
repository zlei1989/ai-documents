import { SkillToggleInputSchema } from '@aidocs/contracts';
import { setSkillEnabled } from '@aidocs/api';
import { json, readSchema, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const PUT = route(async (request) => {
  const { name, enabled } = await readSchema(request, SkillToggleInputSchema);
  return json(setSkillEnabled(name, enabled));
});
