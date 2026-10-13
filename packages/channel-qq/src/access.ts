/**
 * Who may drive this machine over QQ, and how far.
 *
 * A chat channel is a PUBLIC input surface: anybody who can reach the robot can
 * type at it, and a group message reaches every member. The plugin protocol gives
 * a loaded row the same authority the host has — so without this file, every one
 * of those people could raise the permission tier, answer an approval meant for
 * somebody else, or simply ask the model to do things.
 *
 * Two facts are deliberately separate:
 *
 *  - **who** (a bound QQ identity, matched against `actorId` — the MEMBER in a
 *    group, never the group itself);
 *  - **how far** (a ceiling on the permission tier a peer may set for ITS OWN
 *    conversation, which stays below whatever the operator granted locally).
 *
 * ## Authorization is PERSISTENT, not a one-time ceremony
 *
 * This package's second deployment target is a headless server (`noa`,
 * no Web UI at all), and its first is a phone driving a desktop. Both are
 * long-lived relationships, so the binding is durable and the enrollment secret
 * is NOT consumed by use:
 *
 *  - an owner is written into the row's `owners` and keeps working forever, across
 *    restarts and reconnects, with no further ceremony;
 *  - the enrollment secret stays valid until the operator changes it, so a second
 *    device can be added later without re-enrolling the first;
 *  - with no secret configured, one is minted at startup and PRINTED ON THE
 *    CONSOLE — the only channel a GUI-less server has. Nothing here requires a
 *    settings page that a headless deployment does not have.
 *
 * The cost is stated rather than hidden: a live secret is a standing credential,
 * so it is only accepted in a PRIVATE chat (a group reply would publish it to
 * everyone there) and rotating it is a config edit.
 */

/** The permission tiers, weakest first — the order the ceiling compares in. */
const TIER_ORDER = ['read-only', 'auto-edit', 'full'] as const;
export type AccessTier = (typeof TIER_ORDER)[number];

/** Pairing secrets are retypeable from a screen and long enough to be unguessable. */
const PAIRING_CODE_LENGTH = 10;
/** Unambiguous alphabet: no O/0 or I/1 to mistype from a rendered code. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface AccessPolicy {
  /** Bound QQ identities (member openid in a group, user openid in a private chat). */
  owners: readonly string[];
  /** The strongest tier a peer may set for its own conversation. */
  maxTier: AccessTier;
  /**
   * The standing enrollment secret. `undefined` closes enrollment: an operator
   * who wants no new devices simply clears it.
   */
  pairingCode?: string;
}

/** Why one message was refused, or that it was allowed. */
export type AccessVerdict =
  | { kind: 'allow' }
  /** Not bound. The reply is shown verbatim to the sender. */
  | { kind: 'refuse'; reply: string }
  /** A valid secret was presented; `owners` must be persisted. */
  | { kind: 'paired'; actorId: string; reply: string };

/**
 * Whether one identity may control this machine.
 *
 * Kept pure and total: an empty actor (the platform did not say who this is) is
 * NEVER authorized — "we could not tell" must not read as "anybody".
 * @param policy - the bound owners and the tier ceiling.
 * @param actorId - the sender's own platform id.
 * @returns true when this identity is bound.
 */
export function isOwner(policy: AccessPolicy, actorId: string): boolean {
  return actorId.length > 0 && policy.owners.includes(actorId);
}

/**
 * Clamp one requested tier to the ceiling.
 * @param requested - the tier the peer asked for.
 * @param max - the strongest tier a peer may take.
 * @returns the tier actually granted.
 */
export function clampTier(requested: AccessTier, max: AccessTier): AccessTier {
  return TIER_ORDER.indexOf(requested) <= TIER_ORDER.indexOf(max) ? requested : max;
}

/** The `/pair` grammar: a message naming this package's one enrollment verb. */
const PAIR_COMMAND = /^\/pair\s+([A-Za-z0-9]+)$/u;

/**
 * Mint one enrollment secret.
 *
 * Exported because the caller has to PERSIST it (it is the standing secret, not a
 * transient value): an operator's server reboots, and a secret that only ever
 * existed in memory would lock them out of their own machine.
 * @returns the secret to store and to print on the console.
 */
export function mintPairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)] ?? 'X';
  }
  return code;
}

/**
 * The decisions that use the enrollment secret.
 *
 * Stateless: the secret lives in the row's config (durable) rather than in this
 * object, so a restart cannot silently invalidate an operator's enrollment path.
 */
export class AccessGate {
  /**
   * Decide one inbound message.
   *
   * A bound identity is allowed everything this file governs. An unbound one is
   * allowed exactly one thing: presenting the standing secret in a PRIVATE chat.
   * @param policy - the current owners, ceiling and secret.
   * @param actorId - the sender's own platform id.
   * @param kind - the chat the message arrived in.
   * @param text - the message, already mention-stripped and trimmed.
   * @returns the verdict.
   */
  check(policy: AccessPolicy, actorId: string, kind: 'group' | 'c2c', text: string): AccessVerdict {
    if (isOwner(policy, actorId)) return { kind: 'allow' };
    const match = PAIR_COMMAND.exec(text);
    if (match === null) return { kind: 'refuse', reply: refusal(policy) };
    if (kind === 'group') {
      // The secret is a standing credential: answering it in a group would hand it
      // to everybody there, including whoever asked for it.
      return { kind: 'refuse', reply: '配对码只能在和机器人的私聊里使用（群里回复等于把凭据公开）。' };
    }
    const code = match[1];
    const live = policy.pairingCode;
    if (live === undefined || live.length === 0) {
      return {
        kind: 'refuse',
        reply: '这台机器已关闭新设备入网（没有配置配对码）。要接入请在本机重新生成一个并填入配置。',
      };
    }
    if (code === undefined || code.toUpperCase() !== live.toUpperCase()) {
      return { kind: 'refuse', reply: '配对码不正确。请核对后重试；码不会因为一次失败而失效。' };
    }
    if (actorId.length === 0) {
      // Nothing to bind: an identity we cannot name cannot be granted anything.
      return { kind: 'refuse', reply: '无法确认这条消息的发送者身份，配对未完成。' };
    }
    // NOT consumed: the operator may enroll a second device later with the same
    // secret. Rotation is a config edit, which is what makes this a standing
    // arrangement rather than a one-time ceremony.
    return {
      kind: 'paired',
      actorId,
      reply: `配对成功。这个 QQ 号现在可以指挥本机，权限上限：${tierLabel(policy.maxTier)}。`
        + '（配对码不会失效，可继续用于其它设备；要停止入网请在本机清空它。）',
    };
  }
}

/** Human wording for a tier (the same vocabulary the settings page uses). */
export function tierLabel(tier: AccessTier): string {
  if (tier === 'read-only') return '只读';
  if (tier === 'auto-edit') return '自动编辑';
  return '全放行';
}

/** What an unbound sender is told. No hint about whether a secret exists. */
function refusal(policy: AccessPolicy): string {
  const first = policy.owners.length === 0
    ? '这台机器还没有绑定任何 QQ 号。'
    : '这个 QQ 号没有绑定过这台机器。';
  return `${first}如果这是你自己的机器：私聊发送 /pair <配对码>（配对码在启动时的控制台输出里，或本机的设置页里）。`;
}
