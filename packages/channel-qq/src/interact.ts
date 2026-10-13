/**
 * 按钮互动事件（`INTERACTION_CREATE`）的解析。
 *
 * 从 `types.ts` 拆出，因为那是消息事件的词汇表，而互动是另一种入口：没有文本作者，
 * 只有一个被点按钮携带的数据串。互动也要一个被动回复窗口（`msg_id`），所以解析产物
 * 与 `parseInbound` 同形地给出 peer——按钮点击后的回复与普通消息回复走同一条 outbox。
 * 指令按钮平台会直接把命令作为消息推送（不走这个事件），这里只服务回调按钮。
 */
import type { Peer } from './types.js';

/** INTERACTION_CREATE 的 `d`，按官方字段；缺失的字段允许缺（平台在演进）。 */
interface InteractionPayload {
  /** 互动 id（应答 `PUT /interactions/{id}` 用）。 */
  id?: string;
  /** 被点按钮携带的数据（回调按钮的自定义串）。 */
  data?: { button_data?: unknown; group_openid?: unknown; user_openid?: unknown; msg_id?: unknown };
}

/**
 * 从 dispatch 事件解析一次按钮互动；非互动事件返回 undefined。
 *
 * 字段取值刻意防御：`data` 里群聊带 `group_openid`（另有成员的 `user_openid`），
 * 单聊只有 `user_openid`——与消息事件同一个「群是地点、人才是身份」的拆分。
 */
export function parseInteraction(t: string, d: unknown): { interactionId: string; text: string; peer: Peer; msgId?: string } | undefined {
  if (t !== 'INTERACTION_CREATE') return undefined;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined;
  const payload = d as InteractionPayload;
  const data = payload.data;
  if (payload.id === undefined || typeof data !== 'object' || data === null) return undefined;
  const buttonData = data.button_data;
  if (typeof buttonData !== 'string' || buttonData.trim().length === 0) return undefined;
  const group = typeof data.group_openid === 'string' ? data.group_openid : '';
  const user = typeof data.user_openid === 'string' ? data.user_openid : '';
  const peer: Peer | undefined =
    group.length > 0
      ? { kind: 'group', openid: group, peerId: `group:${group}`, actorId: user }
      : user.length > 0
        ? { kind: 'c2c', openid: user, peerId: `c2c:${user}`, actorId: user }
        : undefined;
  if (peer === undefined) return undefined;
  const msgId = typeof data.msg_id === 'string' && data.msg_id.length > 0 ? data.msg_id : undefined;
  return { interactionId: payload.id, text: buttonData.trim(), peer, ...(msgId !== undefined ? { msgId } : {}) };
}
