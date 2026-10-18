/**
 * Opening one durable session over the kernel's live services.
 *
 * Split from `runtime-env.ts` because it answers a different question: the env
 * says what the KERNEL has, this file says what ONE conversation gets. The ask
 * wiring that decides that conversation's calls is built HERE rather than handed
 * in, because its audit sink is this session's own log and that log does not
 * exist until the log is opened — see `session-ask.ts`.
 */
import {
  AgentSession,
  CONTEXT_FRAGMENT_ID_PREFIX,
  newId,
  newSessionDir,
  recordSessionWorkspace,
  Session,
  type AgentHooks,
  type AgentMessage,
  type ApprovalMode,
  type ChatProvider,
  type CompactedSession,
  type CompactSessionOptions,
  type JobRegistry,
  type SessionOpenOptions,
  type ToolDefinition,
  type UserMessage,
} from '@noa/core';
import type { ApprovalPolicyCell } from './permission.js';
import type { CallReviewer } from './reviewer.js';
import { makeSessionAskWiring } from './session-ask.js';
import type { KernelConfig } from './runtime-types.js';

export type { PermissionService } from './permission.js';

/**
 * How one session is opened: the kernel's own shape under this package's name, so
 * importers here read one definition.
 */
export type OpenSessionOptions = SessionOpenOptions;

/** Everything one session handle reads from the kernel, as live accessors. */
export interface OpenSessionDeps {
  config: KernelConfig;
  systemPrompt: string;
  provider: ChatProvider;
  rootDir: () => string;
  tools: () => readonly ToolDefinition[];
  hooks: () => AgentHooks;
  jobs: JobRegistry;
  buildFragment: () => string;
  /** Spill directory for this session's oversized tool output. */
  cacheDir: (sessionId: string) => string;
  /** The compaction strategy (the `compaction` service). */
  compact: (options: CompactSessionOptions) => Promise<CompactedSession>;
  perRequestCompact: boolean;
  /**
   * The kernel's ONE approval-policy cell, shared by every session engine it
   * builds — see `ApprovalPolicyCell` on why `never` is process-wide while the
   * tier is per session.
   */
  policyCell: ApprovalPolicyCell;
  /**
   * The process's default tier for NEW sessions, read live (a surface's
   * settings pick made after boot still reaches conversations opened later by
   * ANY surface — the chat channel included). Absent = the boot config's
   * `approval`. The tier itself stays PER SESSION once chosen.
   */
  approvalDefault?: () => ApprovalMode | undefined;
  /**
   * Whether a human can answer THIS session's `ask_user_question`. A thunk, read
   * per call, for the same reason the tool reads its answerer live: a surface can
   * gain or lose its human without a restart.
   */
  canAskUser: () => boolean;
  /**
   * Input modalities of the model in force, read per request (see
   * `AgentSessionDeps.inputModalities`). Async because the answer comes from the
   * model catalog, and consulted only when a message actually carries an image.
   */
  inputModalities?: () => Promise<readonly string[] | undefined>;
  /** The title model's client accessor, handed straight to the session engine. */
  titleProvider?: () => Promise<ChatProvider | undefined>;
  /**
   * The smart-approval reviewer, when the assembly has one. Reaches the session's
   * ask wiring, where it is composed in front of the human answerer (see
   * `session-ask.ts`). Absent = every gated call asks the human directly.
   */
  reviewer?: CallReviewer;
}

/**
 * One durable session over the kernel wiring: fresh (fragment-seeded,
 * workspace-marked) or resumed (projection-derived, no reseed). The handle
 * reads the LIVE hooks, tools and spill dir, so a rebuild applies to its next
 * run.
 *
 * The ask wiring is built HERE rather than handed in, because its audit sink is
 * this session's log and that log does not exist until `openLog` returns. That
 * binding is what makes "an approval taken in this conversation is recorded in
 * this conversation" true by construction: the previous version resolved the
 * audit target through `current()` at write time, so an approval answered in A
 * landed in whichever conversation happened to be current afterwards.
 */
export async function openAgentSession(
  p: OpenSessionDeps,
  sessionOpts?: OpenSessionOptions,
): Promise<AgentSession> {
  const { session, messages } = await openLog(p, sessionOpts);
  const wiring = makeSessionAskWiring({
    approval: p.approvalDefault?.() ?? p.config.approval,
    rootDir: p.rootDir,
    tools: p.tools,
    policyCell: p.policyCell,
    ...(p.reviewer === undefined ? {} : { reviewer: p.reviewer }),
    audit: (entry) => {
      // Log-only, and a failure to record an audit line must not fail the call
      // it describes; the verdict itself already settled.
      void session
        .appendEvent({
          type: 'approval',
          toolName: entry.toolName,
          kind: entry.kind,
          outcome: entry.outcome,
          at: Date.now(),
        })
        .catch(() => undefined);
    },
  });
  return new AgentSession({
    session,
    messages,
    provider: p.provider,
    rootDir: p.rootDir,
    tools: () => [...p.tools()],
    hooks: p.hooks,
    jobs: p.jobs,
    approvals: wiring.bridge,
    questions: wiring.questions,
    permission: wiring.permission,
    systemPrompt: p.systemPrompt,
    maxTurns: p.config.maxTurns,
    cacheDir: () => p.cacheDir(session.id),
    compact: p.compact,
    canAskUser: p.canAskUser,
    ...(p.config.autoCompactTokenLimit !== undefined
      ? { autoCompactLimit: p.config.autoCompactTokenLimit }
      : {}),
    ...(p.perRequestCompact ? { perRequestCompact: true } : {}),
    ...(p.inputModalities === undefined ? {} : { inputModalities: p.inputModalities }),
    ...(p.titleProvider === undefined ? {} : { titleProvider: p.titleProvider }),
  });
}

/** Fresh (seeded with the context fragment) or resumed (projection-derived). */
async function openLog(
  p: OpenSessionDeps,
  sessionOpts?: OpenSessionOptions,
): Promise<{ session: Session; messages: AgentMessage[] }> {
  if (sessionOpts?.resumeFile !== undefined) {
    const session = await Session.open(sessionOpts.resumeFile);
    return { session, messages: session.deriveMessages() };
  }
  const session = await Session.create(sessionOpts?.sessionDir ?? newSessionDir());
  await recordSessionWorkspace(session, p.rootDir());
  // The dedicated id prefix (not a plain msg_ id) is what lets compaction
  // exclude the fragment by id — see CONTEXT_FRAGMENT_ID_PREFIX.
  const seed: UserMessage = {
    id: newId(CONTEXT_FRAGMENT_ID_PREFIX.slice(0, -1)),
    ts: Date.now(),
    role: 'user',
    content: p.buildFragment(),
  };
  await session.append(seed);
  return { session, messages: [seed] };
}
