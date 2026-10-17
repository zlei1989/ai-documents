import type { ChatEvent, ChatMessage, SessionStatus } from '@aidocs/contracts';

function roundOf(message: ChatMessage): number {
  return typeof message.round === 'number' ? message.round : 0;
}

/**
 * 刷新回放的精简策略：
 * - 保留用户消息、带 `final` 的最终回复、已答复的澄清卡、带生图结果的消息；
 * - 隐藏普通工具卡、思考块、中间文本；
 * - 但如果最后一轮还在 running/waiting（刷新发生在生成过程中），保留该轮全部消息，
 *   让用户仍能看到实时过程，而不是刷新后一片空白。
 */
export function filterReplay(events: ChatEvent[]): ChatEvent[] {
  // 流式增量会反复写同一个 mergeKey；回放只保留最后一条，避免刷新时把几千条 partial 全发给前端。
  const latestByMergeKey = new Map<string, ChatEvent>();
  for (const event of events) {
    if (event.type === 'message') latestByMergeKey.set(event.message.mergeKey, event);
  }
  const deduped = events.filter(
    (event) => event.type !== 'message' || latestByMergeKey.get(event.message.mergeKey) === event,
  );

  let lastStatus: SessionStatus | null = null;
  let maxRound = 0;
  // 旧会话没有 final 标记：每轮最后一条带文本的 assistant 消息即最终回复
  const legacyFinal = new Map<number, string>();

  for (const event of deduped) {
    if (event.type === 'status') {
      lastStatus = event.status;
      continue;
    }
    if (event.type !== 'message') continue;
    const message = event.message;
    const round = roundOf(message);
    if (round > maxRound) maxRound = round;
    if (
      message.role === 'assistant' &&
      message.blocks.some((block) => block.kind === 'text' && block.text.trim())
    ) {
      legacyFinal.set(round, message.mergeKey);
    }
  }

  const liveRound =
    lastStatus === 'running' || lastStatus === 'waiting' ? maxRound : null;
  // 回放只需要当前状态；保留全部 status 会让客户端把历史 done 当成刚结束，触发刷新循环。
  let lastStatusEvent: ChatEvent | null = null;
  for (const event of deduped) {
    if (event.type === 'status') lastStatusEvent = event;
  }

  return deduped.filter((event) => {
    if (event.type === 'status') return event === lastStatusEvent;
    if (event.type !== 'message') return true;
    const message = event.message;
    if (message.role === 'user') return true;
    if (message.final) return true;
    if (message.blocks.some((block) => block.kind === 'clarification' && block.status === 'answered')) {
      return true;
    }
    // 生图结果块：刷新后仍要能看到图片，即使它挂在工具卡消息上
    if (message.blocks.some((block) => block.kind === 'images')) {
      return true;
    }
    const round = roundOf(message);
    if (liveRound !== null && round === liveRound) return true;
    return legacyFinal.get(round) === message.mergeKey;
  });
}
