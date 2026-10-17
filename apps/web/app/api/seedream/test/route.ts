import { testSeedream } from '@aidocs/api';
import { json, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

/** POST /api/seedream/test：Ark 鉴权探针 + Files API 上传/预签名下载探针，失败也返回 200 */
export const POST = route(async () => json(await testSeedream()));
