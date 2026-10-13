/**
 * The human-ask seam: the two brokers a run can park on, their event wiring, and
 * the phase handback that follows a resolution.
 *
 * `AgentSession` used to carry this inline, once per broker, and the second copy
 * was already the bug in waiting: the approval handback tested only the approval
 * broker's queue for "is the run still parked?", so the question path had to
 * remember to test both (or the first one to settle would claim the run was back
 * at its tool while the other ask was still outstanding). Both asks hold the loop
 * the same way, so they belong in one place where `waiting` cannot be forgotten —
 * and where `session.ts`, already at its line ceiling, keeps only the delegation.
 *
 * Publishes through a narrow interface rather than owning a pump: the session's
 * `EventPump` is the single producer of the kernel stream, and it is also what
 * isolates a throwing listener (see `listener_failed`).
 */
import type { ApprovalBroker, ApprovalResolution } from '../approval.js';
import type { AskUserQuestionAnswer, QuestionBroker, QuestionRequest, QuestionResolution } from '../user-question.js';
import type { KernelEvent, TurnPhase } from './protocol.js';

/** What the seam needs from the session it belongs to. */
export interface HumanAskHost {
  /** Publish onto the session's one event stream. */
  publish(event: KernelEvent): void;
  /** Move the run's phase (the session no-ops an unchanged value). */
  setPhase(phase: TurnPhase): void;
  /** Is a run open right now? Decides the phase a resolution hands back to. */
  running(): boolean;
}

/**
 * The seam. Constructed once per session over that session's brokers.
 *
 * `Phase` values are named here rather than passed in: which phase an ask parks
 * the run in is a property of the ask, and a caller that could choose would be
 * free to disagree with the event it is publishing.
 */
export class HumanAskSeam {
  constructor(
    private readonly host: HumanAskHost,
    private readonly approvals: ApprovalBroker,
    private readonly questions: QuestionBroker,
  ) {
    this.approvals.attach(
      (request) => {
        this.host.setPhase('waiting_approval');
        this.host.publish({ type: 'approval_request', request });
      },
      (id: string, resolution: ApprovalResolution) => {
        this.host.publish({ type: 'approval_resolved', id, resolution });
        // The modal is gone; if the run is still open, it is back to waiting on
        // the tool it asked about (or idle when the run unwound with it).
        if (this.waiting()) return;
        this.host.setPhase(this.host.running() ? 'tool' : 'idle');
      },
    );
    this.questions.attach(
      (request) => {
        this.host.setPhase('waiting_question');
        this.host.publish({ type: 'question_request', request });
      },
      (id: string, resolution: QuestionResolution) => {
        this.host.publish({ type: 'question_resolved', id, resolution });
        if (this.waiting()) return;
        this.host.setPhase(this.host.running() ? 'tool' : 'idle');
      },
    );
  }

  /**
   * Is the run parked on a person right now? Every place that used to test only
   * the approval queue asks this instead, so a third ask cannot be added and
   * half-wired.
   */
  waiting(): boolean {
    return this.approvals.outstanding().length > 0 || this.questions.outstanding().length > 0;
  }

  /** Outstanding question batches (a reconnecting surface re-renders these). */
  pendingQuestions(): QuestionRequest[] {
    return this.questions.outstanding();
  }

  /**
   * Answer one outstanding question; false for an unknown id or an answer that
   * does not fit the questions that were asked (see `validateQuestionAnswer`) — a
   * refused answer leaves the wait open for a corrected frame.
   */
  resolveQuestion(id: string, answer: AskUserQuestionAnswer): boolean {
    return this.questions.resolve(id, answer);
  }

  /** The human dismissed a batch; false for unknown/consumed ids. */
  cancelQuestion(id: string): boolean {
    return this.questions.cancel(id);
  }

  /** Fail-closed sweep of the question waits (the session's abort/close paths). */
  failQuestions(reason: 'aborted' | 'closed'): void {
    this.questions.failAll(reason);
  }
}
