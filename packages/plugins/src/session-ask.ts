/**
 * Ask wiring: the approval broker, question seam and permission engine that
 * decide one conversation's tool calls.
 *
 * Its own module because it is a different subject from opening a session
 * (`runtime-session.ts`): this file says WHAT a conversation gets, that file says
 * HOW one is opened. The split is also the point of the design — everything here
 * is PER SESSION, and the one thing that is not (the approval policy) is passed
 * in as a shared cell so the distinction is visible in the signature.
 */
import {
  ApprovalBroker,
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_QUESTION_WAIT_MS,
  QuestionBroker,
  type AgentSession,
  type ApprovalAudit,
  type ApprovalMode,
  type AskFn,
  type ToolCall,
  type ToolCallView,
  type ToolDefinition,
} from '@noa/core';
import { PermissionService, type ApprovalPolicyCell } from './permission.js';
import type { CallReviewer } from './reviewer.js';

/**
 * Compose the reviewer in FRONT of the human answerer.
 *
 * The permission engine only reaches its asker when the tier did NOT auto-allow
 * the call — in `auto` that is execute / read-external / network. The reviewer
 * classifies those; the human is consulted only for `ASK` (and for any failure of
 * the review itself, which is the fail-closed direction: a broken reviewer must
 * never read as consent). `ALLOW` runs the call with no interruption, `DENY`
 * refuses it with a reason the model will read.
 * @param reviewer - the reviewer model.
 * @param human - the existing answerer (publishes an approval card and waits).
 * @param rootDir - live workspace root, for the reviewer's context.
 * @returns the composed asker.
 */
function reviewFirst(reviewer: CallReviewer, human: AskFn, rootDir: () => string): AskFn {
  return async (call, kind) => {
    let verdict;
    try {
      verdict = await reviewer.review({ call, kind, rootDir: rootDir() });
    } catch {
      return await human(call, kind);
    }
    if (verdict.decision === 'allow') return 'allow';
    if (verdict.decision === 'deny') return { answer: 'deny', reason: verdict.reason };
    return await human(call, kind);
  };
}

/**
 * The ask wiring for ONE session.
 *
 * Per SESSION, not per kernel, because one kernel drives several conversations
 * at once (a bot channel keeps one per peer, the browser keeps one per open
 * handle, and a switch leaves the previous run going). A kernel-wide engine made
 * three conversational facts global:
 *
 *  - the TIER (`auto` / `full`): a chat peer raising its own tier raised
 *    everyone's, up to and including the desktop's;
 *  - the REMEMBERED "always allow" grants: approving `git status` in one
 *    conversation silently approved it in every other;
 *  - the ASK's publish slot: `ApprovalBroker.attach` holds ONE publisher, so
 *    whoever created the newest session stole every outstanding ask's card —
 *    session A parked on an approval that only B's surface could see or answer.
 *
 * `audit` is a parameter rather than a container read because it must append to
 * THIS session's log: resolving the target through `current()` at write time
 * recorded an approval taken in A in whichever conversation was current later.
 */
export function makeSessionAskWiring(p: {
  approval: ApprovalMode;
  rootDir: () => string;
  tools: () => readonly ToolDefinition[];
  policyCell: ApprovalPolicyCell;
  audit: (entry: ApprovalAudit) => void;
  /**
   * The smart-approval reviewer, when the assembly has one. Absent = the old
   * behaviour (every non-auto-allowed call goes straight to the human).
   */
  reviewer?: CallReviewer;
  /**
   * 人类等待的兜底上限，秒表在**内核**这一层（见 core 的
   * `DEFAULT_APPROVAL_WAIT_MS` / `DEFAULT_QUESTION_WAIT_MS`）。
   *
   * 缺省即内核默认值，而那已经是「比任何自带超时的 surface 都宽」的兜底：通道自己在
   * 3 分钟（审批）与 10 分钟（提问）就把事情了结了，这里只在没人管的时候生效。要更紧
   * 的装配（一个交互式界面自己知道人能等多久）可以在这里钉死。
   */
  askTimeouts?: { approvalMs?: number; questionMs?: number };
}): { bridge: ApprovalBroker; questions: QuestionBroker; permission: PermissionService } {
  const findTool = (call: ToolCall): ToolDefinition | undefined =>
    p.tools().find((tool) => tool.name === call.name);
  const bridge = new ApprovalBroker(
    (call: ToolCall): ToolCallView | undefined => findTool(call)?.presentCall?.(call.args),
    async (call: ToolCall): Promise<string[]> => {
      // Effect preview is best-effort (never blocks the ask): the tool's own
      // declaration decides what it will do (e.g. edit_file's diff).
      const preview = findTool(call)?.preview;
      if (preview === undefined) return [];
      try {
        const text = (await preview(call.args, { rootDir: p.rootDir() })).trim();
        return text.length > 0 ? text.split('\n') : [];
      } catch {
        return [];
      }
    },
    // 兜底等待上限：内核默认值是给「没有任何人管」的 surface 用的保险，通道那层更紧。
    p.askTimeouts?.approvalMs ?? DEFAULT_APPROVAL_WAIT_MS,
  );
  const asker = p.reviewer === undefined ? bridge.asker : reviewFirst(p.reviewer, bridge.asker, p.rootDir);
  const permission = new PermissionService(p.approval, asker, p.audit, p.policyCell);
  return {
    bridge,
    questions: new QuestionBroker(p.askTimeouts?.questionMs ?? DEFAULT_QUESTION_WAIT_MS),
    permission,
  };
}

/**
 * The KERNEL-level pair, used only for calls that belong to no session (an
 * embedder driving the loop directly, a kernel test).
 *
 * Same constructor as above on purpose — one implementation, two scopes. It
 * shares the caller's `policyCell`, so a headless runner's `never` binds the
 * kernel engine and every session engine alike; its `mode` is the fallback tier
 * a session-less call is judged under.
 */
export function makeKernelAskWiring(p: {
  approval: ApprovalMode;
  rootDir: () => string;
  tools: () => readonly ToolDefinition[];
  policyCell: ApprovalPolicyCell;
  audit: (entry: ApprovalAudit) => void;
  reviewer?: CallReviewer;
  askTimeouts?: { approvalMs?: number; questionMs?: number };
}): { bridge: ApprovalBroker; questions: QuestionBroker; permission: PermissionService } {
  return makeSessionAskWiring(p);
}

/**
 * The audit sink for the KERNEL-level engine.
 *
 * A session-less call has no log of its own, so the line goes to whichever
 * session is current — the best answer available, and precisely why every real
 * conversation builds its own wiring (`makeSessionAskWiring`) instead: routing
 * through `current()` is what recorded an approval taken in one conversation in
 * another.
 * @param currentSession - live read of the session in force.
 * @returns the audit callback.
 */
export function kernelAskAudit(currentSession: () => AgentSession | undefined): (entry: ApprovalAudit) => void {
  return (entry) => {
    // Log-only, and a failure to record an audit line must not fail the call it
    // describes; the verdict itself already settled.
    void currentSession()
      ?.session.appendEvent({
        type: 'approval',
        toolName: entry.toolName,
        kind: entry.kind,
        outcome: entry.outcome,
        at: Date.now(),
      })
      .catch(() => undefined);
  };
}
