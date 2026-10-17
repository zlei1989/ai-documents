import { initStorageGit } from '@aidocs/api';
import { json, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const POST = route(async () => json(initStorageGit()));
