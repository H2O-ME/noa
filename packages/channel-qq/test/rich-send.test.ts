/**
 * 卡片载荷的形状：官方 `msg-btn.md` 的必填字段，以及 `allowIds` 到底限制了谁。
 *
 * 这两件事都出过真实的、只有对端才看得见的故障（按钮点下去「无权限访问」），而
 * 它们的成因在代码里看不出来——`permission` 少了不是类型错误，`type: 2` 配上
 * `specify_user_ids` 也不是类型错误。所以在这里钉住发出的 JSON。
 */
import { describe, expect, it } from 'vitest';
import { buildMessagePlan, cardText, type RichSend } from '../src/rich-send.js';

/** 一个自增的 seq 账本，够一片一片地取。 */
function seqs(): (msgId: string) => number {
  const used = new Map<string, number>();
  return (msgId) => {
    const next = (used.get(msgId) ?? 0) + 1;
    used.set(msgId, next);
    return next;
  };
}

/** 取出末片上的按钮（keyboard 只随末片走）。 */
function buttonsOf(plan: { bodies: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  const last = plan.bodies.at(-1);
  const keyboard = last?.['keyboard'] as { content: { rows: Array<{ buttons: Array<Record<string, unknown>> }> } };
  return keyboard.content.rows.flatMap((row) => row.buttons);
}

const statusCard: RichSend = {
  markdown: cardText(['权限：智能审批', '模型：glm-4.6']),
  keyboard: {
    rows: [
      [
        { label: '新会话', kind: 'command', data: '/new' },
        { label: '帮助', kind: 'command', data: '/help' },
      ],
    ],
  },
};

describe('buildMessagePlan', () => {
  it('always writes action.permission, even when nobody is restricted', () => {
    // 官方表格里 `action.permission.type` 是必填。原先只在 `allowIds` 非空时才写，
    // 于是 `/status` 那张卡整卡没有 permission——点下去平台判「无权限访问」。
    const plan = buildMessagePlan({ content: 'x', msgId: 'm1', rich: statusCard }, seqs());
    const buttons = buttonsOf(plan);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const action = button['action'] as Record<string, unknown>;
      expect(action['permission']).toEqual({ type: 2 });
      // `unsupport_tips` 同为必填，且指令按钮回指它自己的 data。
      expect(action['unsupport_tips']).toBe(`当前 QQ 版本不支持按钮，请直接回复 ${String(action['data'])}`);
    }
  });

  it('restricts with type 0 (指定用户可操作), not type 2 (所有人可操作)', () => {
    // `type: 2` 的定义就是「所有人可操作」，再带 `specify_user_ids` 不构成限制：
    // 群里任何人就都能点「允许」。收紧必须用 type 0。
    const restricted: RichSend = { ...statusCard, allowIds: ['USER_A'] };
    const plan = buildMessagePlan({ content: 'x', msgId: 'm1', rich: restricted }, seqs());
    for (const button of buttonsOf(plan)) {
      const action = button['action'] as Record<string, unknown>;
      expect(action['permission']).toEqual({ type: 0, specify_user_ids: ['USER_A'] });
    }
  });

  it('rides the keyboard on the last chunk only, and carries the command verbatim', () => {
    const long: RichSend = { markdown: 'x'.repeat(11_000), keyboard: statusCard.keyboard };
    const plan = buildMessagePlan({ content: 'x', msgId: 'm1', rich: long }, seqs());
    expect(plan.bodies.length).toBeGreaterThan(1);
    expect(plan.bodies[0]!['keyboard']).toBeUndefined();
    const action = buttonsOf(plan)[0]?.['action'] as Record<string, unknown>;
    expect(action).toMatchObject({ type: 2, data: '/new', enter: true });
  });

  it('keeps a plain-text fallback whose seq does not collide with the rich bodies', () => {
    // 同 msg_id 的多片靠递增 msg_seq 去重：回落体再取一次 seq，不能与富形态撞号。
    const plan = buildMessagePlan({ content: '正文', msgId: 'm1', rich: statusCard }, seqs());
    const seqOf = (bodies: Array<Record<string, unknown>> | undefined): number[] =>
      (bodies ?? []).map((body) => body['msg_seq'] as number);
    expect(seqOf(plan.bodies)).toEqual([1]);
    expect(seqOf(plan.fallback)).toEqual([2]);
  });
});
