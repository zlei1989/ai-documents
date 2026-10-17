import { storageStatus } from '@aidocs/api';
import { route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

/** GET /api/storage/status：storageRoot 解析结果 + git 状态 + 最近提交 */
export async function GET() {
  return route(() => storageStatus())();
}
