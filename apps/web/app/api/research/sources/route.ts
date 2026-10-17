import { listResearchSources } from '@aidocs/api';
import { json, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

/** GET /api/research/sources：数据源清单（设置页勾选用；顺序即展示顺序） */
export const GET = route(async () => json(listResearchSources()));
