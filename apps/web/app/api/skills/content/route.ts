import { ServiceError, readSkillContent } from '@aidocs/api';
import { json, route } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const url = new URL(request.url);
  const origin = url.searchParams.get('origin');
  if (origin !== 'personal' && origin !== 'project') {
    throw new ServiceError('VALIDATION', 'origin 必须是 personal 或 project');
  }
  const name = url.searchParams.get('name')?.trim();
  if (!name) throw new ServiceError('VALIDATION', '缺少参数：name');
  return json(readSkillContent(name, origin));
});
