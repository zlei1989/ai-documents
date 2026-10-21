import { answerClarification } from '@aidocs/api';
import { ClarificationAnswerSchema } from '@aidocs/contracts';
import { readJson, route, validate } from '../../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ group: string; name: string }>;
}

/** POST /api/docs/<group>/<name>/clarifications：回答聊天里那张澄清卡 */
export async function POST(request: Request, context: Context) {
  return route(async () => {
    const { group, name } = await context.params;
    const sessionId = new URL(request.url).searchParams.get('session') ?? undefined;
    const body = validate(ClarificationAnswerSchema, await readJson(request));
    return answerClarification(group, name, body.groupId, body.answers, sessionId);
  })();
}
