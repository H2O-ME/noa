/**
 * The kernel event protocol — what every surface consumes.
 *
 * `KernelEvent` is a superset of the raw `AgentEvent` stream (the 11 loop
 * variants pass through unchanged): it folds in the channels that used to be
 * bypass callbacks and shell-local guesses — approvals and user questions
 * (request/response with a correlation id), generation phase, live tool output,
 * nested-subagent progress, background-job transitions, the running prompt queue,
 * compaction progress and operational notices. A surface that only switches on
 * `event.type` can drive the whole product; nothing outside this protocol is
 * observable, which is what makes surfaces replaceable (browser, bot, headless)
 * and testable against one reducer.
 *
 * Shape and semantics live here; copy, colors and layout never do — a `notice`
 * carries a stable `code` plus a renderable fallback `text`, and each surface
 * decides whether to translate the code or print the text.
 */
import type { AgentEvent, UserMessage } from '../types.js';
import type { ApprovalRequest, ApprovalResolution } from '../approval.js';
import type { QuestionRequest, QuestionResolution } from '../user-question.js';
import type { JobSnapshot } from '../job-types.js';
import type { RunStats } from './metrics.js';
import type { TodoItem } from '../session.js';
import type { Goal } from '../goal.js';
import type { CompactionProgress, NoticeCode, TurnPhase } from './protocol-vocabulary.js';

export type { CompactionProgress, NoticeCode, TurnPhase };

import type { SubagentProgress } from '../tools/subagent.js';

export type KernelEvent =
  | AgentEvent
  /**
   * A user prompt committed to the log (right when `prompt()` is called — queued
   * or immediate — "model-visible means logged"). Surfaces render the transcript
   * row from this instead of echoing locally, so queue flush, reconnect replay
   * and multi-consumer views stay consistent.
   */
  | { type: 'user_message'; message: UserMessage }
  /** Phase transitions, emitted only on change. */
  | { type: 'phase'; phase: TurnPhase }
  /**
   * An approval ask reached the surface: answer via `resolveApproval`. Serialized
   * by the permission engine — at most one outstanding request at a time.
   */
  | { type: 'approval_request'; request: ApprovalRequest }
  /**
   * A request stopped waiting (user answered, run aborted, or session
   * closed) — surfaces clear their modal by this, never by racing resolve().
   */
  | { type: 'approval_resolved'; id: string; resolution: ApprovalResolution }
  /**
   * The model asked the human a question (`ask_user_question`) and the run is
   * suspended inside the ask: answer via `AgentSession.resolveQuestion`, or
   * dismiss the whole batch via `cancelQuestion`. Either way the wait ends — a
   * surface that does neither leaves the run parked until it aborts.
   */
  | { type: 'question_request'; request: QuestionRequest }
  /** A question stopped waiting; surfaces clear their card by THIS, never by racing their own send. */
  | { type: 'question_resolved'; id: string; resolution: QuestionResolution }
  /** Live tail line from a running tool (bash output etc.). */
  | { type: 'tool_progress'; callId: string | undefined; text: string }
  /** Nested subagent lifecycle moment (foreground and background modes). */
  | { type: 'subagent_update'; progress: SubagentProgress }
  /** A background job changed state (start / settle / stop requested). */
  | { type: 'job_update'; job: JobSnapshot }
  /** The pending prompt queue changed (enqueue / flush). */
  | { type: 'queue_update'; items: readonly string[] }
  /**
   * The model rewrote its plan (`todo_write`). Publishes the WHOLE table, not a
   * diff — the tool replaces the list wholesale — so a surface never accumulates
   * and one attaching mid-run reads it from the next write. The durable
   * `todo/write` event is the record (it survives a resume); this is the live
   * signal, so a surface need not poll the log to notice a plan appeared.
   */
  | { type: 'todo'; todos: readonly TodoItem[] }
  /**
   * The goal changed, or was cleared (`null`).
   *
   * A whole-value snapshot with last-write-wins, the same rule as `todo` above and
   * for the same reason: the log-only `goal/change` event is the durable record
   * (so a resume restores the identical goal), and this is the live signal so a
   * surface need not poll. `null` is "no goal", never "unchanged" — a surface
   * replaces its state with whatever arrives.
   */
  | { type: 'goal'; goal: Goal | null }
  /**
   * The model in force changed (a picker switched it, or the surface
   * re-pointed the client). Published so every consumer of this kernel
   * renders the same model — a browser switch moves another surface's status
   * line too — instead of each surface keeping its own copy of a boot-time
   * label.
   */
  | {
      type: 'model';
      /** The id the client now holds — what the next request leaves with. */
      model: string;
      /** The endpoint's id is not a label: the surface's metadata names it. */
      name?: string;
      contextWindow?: number;
    }
  /**
   * A slash command the user ran (not a model turn). `run` opens the command's
   * row, `done` closes it with whatever it had to say — a command that fails is
   * still a settled command, so the reason rides here rather than killing a run.
   * Commands never enter the model's history.
   */
  | { type: 'command'; name: string; phase: 'run' | 'done'; text?: string }
  /**
   * The session's TITLE was just recorded (the log-only `title` marker). Same
   * family as `model`: an out-of-band state announcement so a surface can
   * refresh what it shows about this session (the sidebar row, `/sessions`)
   * without polling — the durable record is the marker, this is the live signal.
   */
  | { type: 'session_titled'; title: string }
  /** An automatic compaction pass made progress. */
  | { type: 'compaction'; progress: CompactionProgress }
  /**
   * The run loop threw — after the abandoned turn's log was repaired.
   * `aborted: true` means the user asked to stop (the loop unwound with it);
   * surfaces distinguish that from a real failure the same way they did when
   * each runner classified it locally.
   */
  | { type: 'run_failed'; message: string; aborted: boolean }
  /** The run is over: its timings and token totals (never logged, never model-visible). */
  | { type: 'run_stats'; stats: RunStats }
  /** Operational line (auto-compact fuse/alias/failure). */
  | { type: 'notice'; code: NoticeCode; text: string };
