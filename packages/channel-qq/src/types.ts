/** 入站事件负载（官方 autogen 事件页；字段按官方示例）。 */

export interface QqAuthor {
  id?: string;
  /** 群聊场景成员 openid。 */
  member_openid?: string;
  /** 单聊场景用户 openid。 */
  user_openid?: string;
  member_role?: string;
  username?: string;
}

export interface QqMessagePayload {
  /** 消息 id：被动回复的 msg_id（外层事件的 d.id）。 */
  id: string;
  author: QqAuthor;
  content: string;
  group_openid?: string;
  timestamp?: string;
}

/** 通道的收发计数：口径是**本次运行**（进程内存，重启归零），不是持久累计。 */
export interface QqBotChannelStats {
  /** 去重后处理过的入站消息数（同一 msg_id 的重复推送只算一条）。 */
  received: number;
  /** 成功发出的回复数（含遥控指令的答复；空答复与发送失败不计）。 */
  replied: number;
  /** 最近一条入站消息的墙钟毫秒时间；一条都没收到就是 undefined。 */
  lastReceivedAt?: number;
}

export type PeerKind = 'group' | 'c2c';

export interface Peer {
  kind: PeerKind;
  openid: string;
  /** `group:<openid>` / `c2c:<openid>`（工具与日志统一使用）。 */
  peerId: string;
  /**
   * WHO sent this message, as the platform identifies them.
   *
   * Separate from `openid` because a group is a PLACE, not a person: `openid` is
   * the `group_openid` (the conversation to answer in), while `actorId` is the
   * member's own id. Authorization needs the second one — a decision about "may
   * this person drive the machine" cannot be made from an id every member of the
   * group shares.
   *
   * Empty when the platform did not identify the sender; an unknown actor is
   * never treated as authorized.
   */
  actorId: string;
}

/** The bot's own mentions at the START of a group message, as the platform sends them. */
const LEADING_MENTION = /^(?:\s*<@!?[A-Za-z0-9_-]+>|\s*<@!?[A-Za-z0-9_-]+>\s*)+/u;

/**
 * Strip the robot's own leading `@` markers from a group message.
 *
 * A group message arrives as `<@!bot_openid> /help` — the platform includes the
 * mention in `content`, so a peer who taps the robot and types a slash command
 * produced a line that started with `<`, not `/`. Every parser here keys off the
 * first character, so the command was silently sent to the model as prose: the
 * "slash commands do not work in groups" bug, and the reason it worked in DMs.
 *
 * Deliberately NOT a general mention stripper: only LEADING markers of the
 * `<@...>` shape are removed, and only so a command can be recognized. A mention
 * in the middle of a sentence is part of what the operator wrote, and removing it
 * would change the prompt the model receives.
 * @param content - the raw message content.
 * @returns the content without leading bot mentions.
 */
export function stripLeadingMention(content: string): string {
  return content.replace(LEADING_MENTION, '');
}

/** 从 dispatch 事件解析对端；非消息事件返回 undefined。 */
export function parseInbound(t: string, d: unknown): { peer: Peer; message: QqMessagePayload } | undefined {
  if (t !== 'GROUP_AT_MESSAGE_CREATE' && t !== 'C2C_MESSAGE_CREATE') return undefined;
  // A non-object payload is not a message. `null` is VALID JSON, so a gateway
  // frame carrying `d: null` used to reach `msg.content` and throw a TypeError out
  // of a socket listener — which takes the process down rather than the
  // connection.
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined;
  const msg = d as QqMessagePayload;
  if (typeof msg.content !== 'string' || typeof msg.id !== 'string') return undefined;
  if (t === 'GROUP_AT_MESSAGE_CREATE') {
    if (typeof msg.group_openid !== 'string' || msg.group_openid.length === 0) return undefined;
    // The platform puts the robot's own mention INTO `content` for a group
    // message, so the operator's text is whatever follows it. Normalizing here —
    // in the one function that decodes the platform — means every consumer
    // (command parsing, the model prompt, the dedupe key) sees the same sentence
    // instead of each stripping it again, or forgetting to.
    return {
      peer: {
        kind: 'group',
        openid: msg.group_openid,
        peerId: `group:${msg.group_openid}`,
        // The MEMBER, not the group: see `Peer.actorId`.
        actorId: typeof msg.author?.member_openid === 'string' ? msg.author.member_openid : '',
      },
      message: { ...msg, content: stripLeadingMention(msg.content) },
    };
  }
  const user = typeof msg.author?.user_openid === 'string' ? msg.author.user_openid : '';
  if (user.length === 0) return undefined;
  return { peer: { kind: 'c2c', openid: user, peerId: `c2c:${user}`, actorId: user }, message: msg };
}
