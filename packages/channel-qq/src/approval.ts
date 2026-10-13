/**
 * 一条审批请求的**推送 + 兜底**：发到 QQ、超时必定拒绝（fail-closed）。
 *
 * 从对端编排（`peers.ts`）拆出，因为它是另一个问题：那边讲**一轮怎么跑**（会话编排、
 * 遥控指令落地、结果收敛），这里讲**一条审批没人理时怎么收敛**（问出去的措辞、
 * 到点自动拒绝、结论到了撤定时器）。前者每个对端一个实例、跟着会话走；后者是单条
 * 请求的生命周期、跟着审批 id 走。
 */
import type { AgentSession } from '@noa/core';
import type { Peer } from './types.js';
import { REMOTE_APPROVAL_TIMEOUT_MS } from './remote.js';
import type { PeerNotifier } from './peers.js';

/**
 * One outstanding ask, from "sent to QQ" to "resolved or timed out".
 *
 * The answers arrive as LATER inbound messages (`/approve` rides the channel's
 * bypass straight to `resolveApproval`), so the wait is never awaited here —
 * this half only asks and arms the fallback. A peer that never answers must
 * still converge: the timer denies on their behalf, the same fail-closed
 * discipline the kernel applies when a socket drops with an ask outstanding.
 */
export class ApprovalForwarder {
  /** Each peer's UNANSWERED approval timer (the kernel serializes asks). */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly notify: PeerNotifier = () => undefined,
  ) {}

  /**
   * Push one approval request to QQ and arm its must-deny timer.
   * @param agent - the session waiting on this approval.
   * @param peer - who to ask.
   * @param request - the kernel's approval request.
   */
  forward(agent: AgentSession, peer: Peer, request: { id: string; call: { name: string } }): void {
    const preview = 'preview' in request ? (request as { preview?: readonly string[] }).preview : undefined;
    const lines = [`需要审批：${request.call.name}`];
    if (preview !== undefined && preview.length > 0) lines.push(...preview.slice(0, 20));
    lines.push('回复 /approve 允许，或 /deny 拒绝（超时将自动拒绝）。');
    this.notify(peer, lines.join('\n'));
    const timer = setTimeout(() => {
      this.timers.delete(request.id);
      // `resolveApproval` returns false for a settled id, so the fallback is a
      // harmless duplicate attempt rather than a second decision.
      agent.resolveApproval(request.id, { answer: 'deny', reason: 'QQ 对端超时未答复，按拒绝处理' });
      this.notify(peer, `审批超时（${Math.round(REMOTE_APPROVAL_TIMEOUT_MS / 1000)} 秒未回复），已按拒绝处理：${request.call.name}`);
    }, REMOTE_APPROVAL_TIMEOUT_MS);
    this.timers.set(request.id, timer);
  }

  /** The ask has a verdict: stand the fallback down. */
  settled(id: string): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  /**
   * Drop every outstanding timer.
   *
   * The channel is a plugin now, so switching its row off must leave nothing
   * running: a must-deny timer surviving its fiber would fire into a session
   * nobody is serving, and would be exactly the "remembered teardown" this
   * refactor removes. The peer's own ask is left to the session's teardown.
   */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
