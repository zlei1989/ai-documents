import { z } from 'zod';
import { activateChatSession, createChatSession, listChatSessions } from '@aidocs/api';
import { readJson, route, validate } from '../../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

const ActivateBody = z.object({ activeId: z.string().min(1) });

/** GET /api/docs/<group>/<name>/sessions：会话清单 + 当前会话 */
export async function GET(_request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    return listChatSessions(group, name);
  })();
}

/** POST /api/docs/<group>/<name>/sessions：新建会话并切换过去 */
export async function POST(_request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    return createChatSession(group, name);
  })();
}

/** PATCH /api/docs/<group>/<name>/sessions：切换当前会话 */
export async function PATCH(request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    const body = validate(ActivateBody, await readJson(request));
    return activateChatSession(group, name, body.activeId);
  })();
}
