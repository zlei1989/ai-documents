import { listSkills } from '@aidocs/api';
import { json, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route(async () => json(listSkills()));
