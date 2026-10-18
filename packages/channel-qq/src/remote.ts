/**
 * 遥控：把一条认得的指令**真的接到内核上**（`remote-parse.ts` 只负责认字）。
 *
 * Functionally it consumes exactly three seams, so it works for whoever holds
 * them; a channel plugin holds the per-peer session and whatever seats the host
 * published, and every seat it does NOT hold answers honestly instead of
 * pretending a switch landed:
 *  - **权限档** → `AgentSession.setApprovalMode()`
 *  - **审批** → 不自动拒绝：把请求发到 QQ、等对端回 `/approve` / `/deny`，走
 *    `pendingApprovals()` / `resolveApproval()`。超时**必定拒绝**（fail-closed）。
 *  - **换模型** → 模型座位（有才有，没有就说没有）
 *  - **工作区** → 工作区座位（同上；校验与拒绝归内核）
 *  - **会话** → 注入的 `newSession()`，由调用方换掉自己那份对端表
 *
 * 全部依赖注入，所以每一条都能对着假实现直接驱动，不需要网络也不需要真内核。
 */
import { errMessage, interjectionText } from '@noa/core';
import {
  costOf,
  type AgentSession,
  type ApprovalMode,
  type AskResult,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type PricingTable,
  type TurnRewind,
  type UsageStats,
} from '@noa/core';
import { labelOf, rowTitle, stampOf } from './relay-candidates.js';
import { answerPendingQuestion } from './question-answer.js';
import { cardText, type QqKeyboard, type RichSend } from './protocol.js';
import type { RemoteCommand, RemotePerm } from './remote-parse.js';
import type { TurnInput } from './types.js';

/**
 * The kernel capabilities remote control needs — exactly the seats named in the
 * module header and nothing else.
 *
 * `models` and `setWorkspace` are OPTIONAL because a plugin is handed
 * capabilities, not the kernel: no capability moves the workspace today, so a
 * peer's `/ws` must say so rather than claim a move that never happened. Absent
 * is a fact to report, not a silent no-op — the same discipline `/model` already
 * followed for a process with no model seat.
 */
export interface RemoteKernelPort {
  /** Move the workspace, when this process has a seat for it. Absent = it does not. */
  setWorkspace?(dir: string): Promise<unknown>;
  rootDir(): string;
  /**
   * The model id in force — a READ, separate from the switching seat below.
   * A process can know which model it is sending without being able to change
   * it, and `/status` must be able to say so.
   */
  model?(): string | undefined;
  /** The model switching seat (list + select), when this process has one. */
  models?: {
    current(): string;
    list(): Promise<readonly { models: readonly { id: string }[] }[]>;
    select(model: string): Promise<{ id: string }>;
    /**
     * Write one id down as this deployment's default (`/model default <id>`).
     *
     * Optional INSIDE the seat because it is a different authority: switching
     * retargets this process, this rewrites the config the next process reads. A
     * seat without it can still switch, and the reply says the default did not
     * change rather than implying it did.
     */
    setDefault?(model: string): Promise<{ ok: boolean; reason?: string }>;
    /** The model the config file names now, for "switch" vs "default" talk. */
    configuredDefault?(): Promise<string | undefined>;
  };
}

/** Every id the endpoint publishes, flattened out of its groups. */
async function seatIds(seat: NonNullable<RemoteKernelPort['models']>): Promise<string[]> {
  const groups = await seat.list().catch(() => [] as readonly { models: readonly { id: string }[] }[]);
  return groups.flatMap((group) => group.models.map((model) => model.id));
}

/** The "these are the ones that exist" tail of a refused switch. */
async function optionsHint(seat: NonNullable<RemoteKernelPort['models']>): Promise<string> {
  const ids = await seatIds(seat);
  if (ids.length === 0) return '端点没有公布任何模型（`GET /models` 空或不可达），用 /model 再试一次。';
  return `可选：\n${ids.map((id) => `- ${id}`).join('\n')}`;
}

/**
 * The per-peer session handle remote control needs.
 *
 * Separate from `RemoteKernelPort` because these are facts about THIS peer's
 * conversation (its tier, its outstanding ask), while the port is about the
 * shared kernel. The bridge owns the session per peer, so it supplies both.
 */
export interface RemoteSessionPort {
  setApprovalMode(mode: ApprovalMode): void;
  /** The tier actually in force — the read-back that proves the write landed. */
  approvalMode(): ApprovalMode | undefined;
  pendingApprovals(): readonly { id: string; call: { name: string } }[];
  resolveApproval(id: string, answer: AskResult): boolean;
  /** Interrupt the current run (the remote Ctrl+C). */
  abort(): void;
  /** Whether a run is in flight, so `/stop` can answer honestly. */
  running(): boolean;
  /** The outstanding `ask_user_question` batches, for `/answer`. */
  pendingQuestions(): readonly { id: string; questions: readonly AskUserQuestionItem[] }[];
  resolveQuestion(id: string, answer: AskUserQuestionAnswer): boolean;
  /**
   * This conversation's cumulative usage, for `/usage`.
   *
   * Optional because it is a READOUT: an assembly whose sessions keep no token
   * accounting still runs this channel perfectly well, and `/usage` then says so
   * rather than printing zeros. "Spent nothing" and "cannot be read" are different
   * facts, and only one of them is worth acting on.
   */
  usage?(): UsageStats;
  /**
   * Take back the last `turns` turns from this conversation's model surface
   * (`/undo`, `/retry`).
   *
   * Required, unlike `usage`: this is a method on every session rather than a
   * capability an assembly may or may not keep, so a deployment where `/undo`
   * cannot work does not exist. Absent would only invite a branch that is dead
   * code everywhere.
   *
   * Returns undefined when the surface holds no turn to drop; THROWS when a run
   * is in flight (the kernel refuses to splice the surface under a live request),
   * which the caller reports rather than swallows.
   */
  rewind(turns: number): Promise<TurnRewind | undefined>;
}

/** How long a remote approval waits before it fails closed. */
export const REMOTE_APPROVAL_TIMEOUT_MS = 3 * 60_000;

/** 权限档 → 中文读数（与设置页 / REPL 同一套词汇）。 */
const PERM_LABEL: Readonly<Record<RemotePerm, string>> = {
  auto: '智能审批',
  full: '全放行',
};

/**
 * `/help`: the vocabulary IS the manual.
 *
 * Built from the seats this process actually has, because a help line for a
 * command that can only answer "this process has no seat for that" teaches the
 * peer a command that will not work. The commands that always work (permission
 * tier, approvals, a new session, `/stop`, `/answer`) are always listed.
 *
 * It takes the WHOLE context rather than just the kernel port, and that is the
 * fix for a real defect: the relay verbs (`/sessions`, `/use`, `/unbind`) live on
 * `ctx.relay`, so a builder that could only see `kernel` could never list them —
 * `/help` was advertising six verbs while the parser accepted eleven, and the one
 * it omitted is the reason to have this channel at all (会话接力: point the phone
 * at the conversation the desktop is working in). A help text that hides a verb is
 * indistinguishable from a missing verb to whoever is reading it.
 * @param ctx - the seats in force.
 * @returns the help text.
 */
export function remoteHelpLines(ctx: RemoteContext): string[] {
  const { kernel, relay } = ctx;
  const lines = [
    '可用遥控指令：',
    '/status — 看当前工作区 / 模型 / 权限 / 待审批',
    '/usage — 看本会话的 token 用量（配了 pricing 还给出估算成本）',
    '/perm auto|full（/approvals 同义）— 切换权限档（auto=智能审批，full=全放行）',
  ];
  if (kernel.models !== undefined) {
    lines.push('/model — 列出可选模型；/model <id> — 切换（本进程，重启回到配置里的默认）');
    // 只有真的能写回配置文件才宣传这条：没有那个座位时 `/model default` 只会回
    // 「默认模型没改」，把一个做不到的动词写进帮助里，等于教对端一条没用的指令。
    if (kernel.models.setDefault !== undefined) {
      lines.push('/model default <id> — 切换**并**写成默认（改 config.json，下次启动仍是它）');
    }
  }
  lines.push('/ws — 看当前工作区');
  if (kernel.setWorkspace !== undefined) lines.push('/ws <目录> — 切换工作区');
  lines.push('/new — 为这个对话开一个新会话');
  if (relay !== undefined) {
    lines.push(
      '/sessions — 列出活着的会话（每行：标题 · 标记 · 工作区 · 时间 · 句柄）',
      '/use <句柄> — 把本对话接到其中一个上（句柄是 /sessions 每行最后那段）',
      '/unbind — 放开别人的会话，本对话从自己的新会话重新开始',
    );
  }
  lines.push(
    '/stop — 中止本对话正在跑的任务',
    '/undo [n] — 回退最近 n 轮（缺省 1 轮），让模型不再看到它们（日志仍保留）',
    '/retry — 回退最近一轮并重发那句话',
    '/answer <答案> — 回答 agent 的提问（也可用选项编号，如 /answer 2）',
    '/approve — 允许待审批的命令；/deny — 拒绝',
    '/help — 这份清单',
    '（不认得的 / 开头行、以及所有其它文本，都原样作为提示词发给 agent。）',
  );
  return lines;
}

/** 纯文本版帮助（文本回落与卡片同源）。 */
export function remoteHelp(ctx: RemoteContext): string {
  return remoteHelpLines(ctx).join('\n');
}

/**
 * Wait for a remote approval answer. **The timeout is the point.** A QQ peer may simply not answer (they walked
 * away, the phone died, the group scrolled past), and an ask that waits forever
 * parks the whole run. So the wait has an explicit bound and fails closed to a
 * denial — the same discipline the kernel uses when a socket drops with an ask
 * outstanding.
 *
 * Exported so a caller holding a promise-shaped ask gets the SAME bound instead
 * of inventing a second one. It is not what `PeerTurns` uses, and the difference
 * is the protocol, not an oversight: a peer answers by sending a LATER MESSAGE,
 * so the parked wait lives at the ask (`PeerTurns.forwardApproval`'s timer),
 * where there is no promise to race. Both read `REMOTE_APPROVAL_TIMEOUT_MS`.
 * @param ask - sends the question and resolves with one reply line.
 * @param timeoutMs - the bound; defaults to the shared constant.
 * @returns the reply line, or undefined on timeout (the caller then denies).
 */
export async function awaitRemoteAnswer(
  ask: (question: string) => Promise<string>,
  timeoutMs: number = REMOTE_APPROVAL_TIMEOUT_MS,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([
      ask('有待审批的命令，请回复 /approve 允许或 /deny 拒绝（超时将自动拒绝）。'),
      expired,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One live conversation this chat could drive instead of its own.
 *
 * `target` is the short handle a peer types (`/use a1b2c3`), derived from the
 * session id so it is stable for the life of that session. `mine` says whether it
 * is already the one this chat is driving.
 */
export interface RelayCandidate {
  /** The short, typeable handle (`/use <target>`). */
  target: string;
  /** The session id, for a reply that wants to be unambiguous. */
  id: string;
  /**
   * The session LOG this row stands for — what `/use` binds.
   *
   * A row may come from the disk catalog rather than from an open handle, so the
   * file is the one thing that identifies the conversation in both cases.
   */
  file: string;
  /**
   * Where it runs, as the session recorded it — the FULL path. A row that named
   * only the last segment read `agent` for every conversation under one project,
   * which is the same as naming nothing.
   */
  where: string;
  /**
   * When it was last used (epoch ms). Two conversations in one directory whose
   * opening lines read alike are still told apart by when they happened.
   */
  at: number;
  /**
   * What the conversation is about: the opening prompt, one line. Empty for a
   * session nobody has used yet.
   *
   * This is what makes the listing a CHOOSER. Without it the row is a handle and a
   * directory — and when every conversation lives in the same directory, that is
   * one fact repeated per row, which is the same as no facts at all.
   */
  title: string;
  /** Whether a run is in flight right now. */
  busy: boolean;
  /** Whether this chat already drives it. */
  mine: boolean;
}

/**
 * Session relay: the phone-driving-a-desktop seat.
 *
 * Separate from `RemoteKernelPort` because these are operations on OTHER
 * conversations, not on the one this chat is already in — and absent means this
 * deployment has no relay (a channel whose sessions are all its own), which the
 * commands report rather than pretending a switch landed.
 */
export interface RemoteRelayPort {
  list(): Promise<readonly RelayCandidate[]>;
  /** Point this chat at one conversation. Refuses an unknown/ambiguous handle. */
  use(target: string): Promise<{ ok: true; candidate: RelayCandidate } | { ok: false; reason: string }>;
  /** Let go: this chat owns a fresh conversation again. */
  unbind(): Promise<void>;
  /** The conversation this chat is driving now, when it came from a relay. */
  bound(): RelayCandidate | undefined;
}

/** 执行一条指令所需的全部接缝。 */
export interface RemoteContext {
  kernel: RemoteKernelPort;
  session: RemoteSessionPort;
  /** 为这个对端开一个新会话（`/new`）；调用方据此换绑自己那份对端表。 */
  newSession: () => Promise<AgentSession>;
  /** Session relay, when this deployment has other conversations to offer. */
  relay?: RemoteRelayPort;
  /**
   * What each model costs, when the deployment wrote a price table (USD per
   * million tokens — see `core/pricing.ts`).
   *
   * Here rather than on the kernel port because it is not a capability of the
   * process, it is a line in the operator's config: `/usage` reads it to put a
   * number on token counts, and its ABSENCE is reported as "unpriced" rather than
   * as $0.00 — a figure nobody can tell apart from free.
   */
  pricing?: PricingTable;
}

/** 一句话回复 +（`/new` 时）要换绑的新会话句柄。 */
export interface RemoteOutcome {
  reply: string;
  /** 富样式（markdown 正文 + 按钮卡）：目前只有 `/help` 出，其余指令纯文本。 */
  rich?: RichSend;
  /** Present for `/new`: the caller rebinds this peer to it. */
  nextAgent?: AgentSession;
  /**
   * A prompt to run through the NORMAL prompt door, whose answer replaces `reply`
   * when present.
   *
   * `/retry` is the only producer, and the field exists so that the verb can be
   * described ENTIRELY here — what to drop, and what to say again — while the run
   * itself stays where every other prompt runs (`peers.ts`). The other split,
   * special-casing `/retry` inside `peers.ts`, would put half the verb in the
   * parser and half in the orchestrator, which is the drift this module's single
   * door exists to prevent.
   */
  resend?: TurnInput;
}

/** `/status` 的读数。 */
function statusLines(ctx: RemoteContext): string[] {
  const mode = ctx.session.approvalMode();
  const label = mode === undefined ? '未知' : (PERM_LABEL[mode] ?? mode);
  const pending = ctx.session.pendingApprovals().length;
  const model = ctx.kernel.models?.current() ?? ctx.kernel.model?.() ?? '未知（本进程没有模型读数）';
  return [
    `工作区：${ctx.kernel.rootDir()}`,
    `模型：${model}`,
    `权限：${label}`,
    pending > 0 ? `待审批：${pending} 条（回复 /approve 或 /deny）` : '无待审批',
  ];
}

/** 千位分隔：手写而不是 `toLocaleString`，因为读数不该随进程的 locale 变。 */
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * 金额读数。
 *
 * 常驻机器人会同时遇到两种量级 —— 一次问答的零点几厘，和一个月的几块钱 —— 所以精度
 * 跟着量级走。**绝不把非零印成 $0**：`<$0.000001` 是实话，`$0` 是「免费」，两者对
 * 读账单的人是相反的结论。
 */
function usd(amount: number): string {
  if (amount <= 0) return '$0';
  if (amount < 0.000_001) return '<$0.000001';
  if (amount < 0.01) return `$${amount.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`;
  return `$${amount.toFixed(4)}`;
}

/**
 * `/usage` 的读数。
 *
 * Two states, and the difference is the point: a deployment that wrote no price
 * table still gets its token totals, and the cost line then says the model is
 * UNPRICED instead of printing `$0.00`. An unpriced model is not a free one, and a
 * readout that cannot tell them apart is worse than no readout.
 * @param ctx - the seats in force.
 * @returns the lines, headed by which model they describe.
 */
function usageLines(ctx: RemoteContext): string[] {
  const usage = ctx.session.usage?.();
  if (usage === undefined) {
    return ['这个进程读不到本会话的用量：会话没有 token 记账（换一个装配，或看内核的 metrics）。'];
  }
  const model = ctx.kernel.models?.current() ?? ctx.kernel.model?.() ?? '未知';
  const lines = [
    `轮次：${count(usage.turns)}`,
    `输入：${count(usage.promptTokens)} token${usage.cachedTokens > 0 ? `（缓存命中 ${count(usage.cachedTokens)}）` : ''}`,
    `输出：${count(usage.completionTokens)} token`,
  ];
  // Only when there IS a miss: a provider that never reports caching leaves this
  // at zero by construction, and a permanent "未命中缓存：0" would read as a defect.
  if (usage.missTokens > 0) {
    lines.push(`其中未命中缓存：${count(usage.missTokens)} token（按全价计，共 ${count(usage.missTurns)} 轮）`);
  }
  lines.push(costLine(model, usage, ctx.pricing));
  return [`📊 本会话用量（${model}）：`, ...lines];
}

/**
 * The cost line: an estimate, a lower bound, or an honest "unpriced".
 * @param model - the model in force.
 * @param usage - the session's cumulative totals.
 * @param pricing - the deployment's price table, when it wrote one.
 * @returns the line.
 */
function costLine(model: string, usage: UsageStats, pricing: PricingTable | undefined): string {
  const hint = `在 config.json 的 pricing 里给 ${model} 填 input/output（每百万 token 的美元价）`;
  if (pricing === undefined) return `成本：未配价 —— ${hint}。`;
  const estimate = costOf(model, usage, pricing);
  if (estimate === undefined) return `成本：${model} 未配价 —— ${hint}。`;
  const sides = [
    estimate.inputUSD === undefined ? undefined : `输入 ${usd(estimate.inputUSD)}`,
    estimate.outputUSD === undefined ? undefined : `输出 ${usd(estimate.outputUSD)}`,
  ].filter((side): side is string => side !== undefined);
  // `≥` when one side is unpriced: the sum is a floor, not the bill, and the
  // distinction is exactly what the `partial` flag was carried out of core for.
  const mark = estimate.partial ? '≥' : '≈';
  const note = estimate.partial ? '；未配价的一侧未计入' : '';
  return `成本：${mark} ${usd(estimate.totalUSD)}（${sides.join(' + ')}${note}）`;
}

/**
 * Take back turns, phrasing the refusals a peer can actually hit.
 *
 * A discriminated result rather than a throw, because both callers (`/undo` and
 * `/retry`) must ANSWER either way, and the two failure modes need different
 * sentences: "there is nothing to take back" is a state of the conversation
 * (reported in the caller's own verb — `/retry` is not a kind of `/undo` to
 * whoever typed it), while the kernel's "a run is in flight" is a refusal the peer
 * can act on (wait, or `/stop`).
 * @param ctx - the seats in force.
 * @param turns - how many turns to drop.
 * @param empty - the sentence for "this conversation has no turn to drop".
 * @returns the cut, or the sentence to send back instead.
 */
async function attemptRewind(
  ctx: RemoteContext,
  turns: number,
  empty: string,
): Promise<{ ok: true; plan: TurnRewind } | { ok: false; reply: string }> {
  try {
    const plan = await ctx.session.rewind(turns);
    if (plan === undefined) return { ok: false, reply: empty };
    return { ok: true, plan };
  } catch (err) {
    return { ok: false, reply: `回退失败：${errMessage(err)}` };
  }
}

/**
 * Execute one parsed command.
 *
 * Every branch ANSWERs — a remote command that silently did nothing is
 * indistinguishable from a broken channel, and the peer has no other way to tell.
 * @param command - the parsed command.
 * @param ctx - the kernel and session seams.
 * @returns the text to send back, plus the new session for `/new`.
 */
export async function runRemoteCommand(command: RemoteCommand, ctx: RemoteContext): Promise<RemoteOutcome> {
  switch (command.kind) {
    case 'help': {
      // 菜单按钮（指令按钮，点击即发出）与文字版同义：一样的话给两种入口。
      const rows: QqKeyboard['rows'] = [
        [
          { label: '状态', kind: 'command', data: '/status' },
          { label: '会话列表', kind: 'command', data: '/sessions' },
          { label: '新会话', kind: 'command', data: '/new' },
        ],
        [
          { label: '智能审批', kind: 'command', data: '/perm auto' },
          { label: '全放行', kind: 'command', data: '/perm full' },
        ],
        [
          { label: '停止任务', kind: 'command', data: '/stop' },
          { label: '帮助', kind: 'command', data: '/help' },
        ],
      ];
      return {
        reply: remoteHelpLines(ctx).join('\n'),
        rich: { markdown: cardText(remoteHelpLines(ctx)), keyboard: { rows } },
      };
    }
    case 'status': {
      // 状态卡：markdown 渲染 + 一行常用按钮，遥控的主要入口值得一整张卡。
      const rows: QqKeyboard['rows'] = [
        [
          { label: '新会话', kind: 'command', data: '/new' },
          { label: '会话列表', kind: 'command', data: '/sessions' },
          { label: '帮助', kind: 'command', data: '/help' },
        ],
      ];
      const lines = statusLines(ctx);
      return { reply: lines.join('\n'), rich: { markdown: cardText(lines), keyboard: { rows } } };
    }
    case 'usage': {
      const lines = usageLines(ctx);
      return { reply: lines.join('\n'), rich: { markdown: cardText(lines) } };
    }
    case 'undo': {
      const attempt = await attemptRewind(ctx, command.turns, '没有可以回退的轮次：这段会话里还没有用户提示词。');
      if (!attempt.ok) return { reply: attempt.reply };
      // Say what actually went, not what was asked for: `/undo 99` on a two-turn
      // conversation drops two, and a reply echoing "99" would be the same class
      // of lie as a permission switch that never landed.
      return {
        reply: `已回退 ${attempt.plan.dropped} 轮。这些消息仍在日志里（只是不再进模型上下文），需要的话可以 /new 开一段干净的会话。`,
      };
    }
    case 'retry': {
      const attempt = await attemptRewind(ctx, 1, '没有可以重做的轮次：这段会话里还没有用户提示词。');
      if (!attempt.ok) return { reply: attempt.reply };
      // No reply of its own: the answer to the re-sent prompt IS the reply, and
      // spending one of this inbound message's outbound allowance on an
      // acknowledgement would risk the reserve the answer needs (see `outbox.ts`).
      const { prompt } = attempt.plan;
      return {
        reply: '',
        resend: {
          // 被撤销的那一轮若是一次**中途插话**，正文里带着给模型的插话标记
          // （`interjection.ts`）。重发时必须把标记剥掉：这一次它不是插话——没有
          // 「正在跑的那一轮」可以插进去，它会作为一条普通提示词开一轮新的。留着标记
          // 等于对模型说一句当时为真、现在为假的话。
          text: interjectionText(prompt.content),
          ...(prompt.images === undefined ? {} : { images: prompt.images }),
        },
      };
    }
    case 'perm': {
      ctx.session.setApprovalMode(command.mode);
      // Read back rather than echoing: `setApprovalMode` no-ops when a session
      // has no permission service, and claiming a switch that did not land is
      // worse than admitting it.
      const now = ctx.session.approvalMode();
      if (now !== command.mode) return { reply: `权限未能切换（当前：${now ?? '未知'}）。` };
      return { reply: `权限已切到「${PERM_LABEL[command.mode]}」。` };
    }
    case 'model': {
      const seat = ctx.kernel.models;
      // 座位不在 = 本部署没有可切换的模型目录。原来这句写的是「端点未配置或不可切换，
      // 换模型请在设置页操作」——两头都不实：端点配着、进程正在用它说话，而 Noa 根本没
      // 有设置页。现在照实说清「默认写在哪个文件、改它要不要重启」。
      if (seat === undefined) {
        return { reply: `这个进程没有模型切换座位：本部署的模型写在 config.json 的 provider.model 里，改它请编辑该文件后重启。` };
      }
      let option: { id: string };
      try {
        // 端点清单是唯一权威（Hermes 的 `_validate_switch` 同一纪律）：拼错的名字在
        // 这里被拒并把可选项列出来，而不是让上游回一个 404、让人以为端点坏了。
        option = await seat.select(command.model);
      } catch (err) {
        return { reply: `模型未切换：${errMessage(err)}\n${await optionsHint(seat)}` };
      }
      if (command.persist !== true) {
        return {
          reply: `模型已切到 ${option.id}（本进程，所有对话一起变；重启后回到配置文件里的默认）。\n写成默认用 /model default ${option.id}。`,
        };
      }
      const defaults = ctx.kernel.models;
      if (defaults?.setDefault === undefined) {
        return { reply: `模型已切到 ${option.id}，但本进程没有可写的配置文件，默认模型没改。` };
      }
      const written = await defaults.setDefault(option.id);
      return {
        reply: written.ok
          ? `模型已切到 ${option.id}，并已写成默认（下次启动仍是它）。`
          : `模型已切到 ${option.id}，但默认模型没写成：${written.reason ?? '未知原因'}。`,
      };
    }
    case 'models': {
      const seat = ctx.kernel.models;
      if (seat === undefined) {
        return { reply: `这个进程没有模型切换座位：本部署的模型写在 config.json 的 provider.model 里，改它请编辑该文件后重启。` };
      }
      const ids = await seatIds(seat);
      if (ids.length === 0) {
        return { reply: '端点没有公布任何模型（`GET /models` 空或不可达），所以没有可切的清单。' };
      }
      const list = ids.map((id) => `- ${id}`).join('\n');
      return {
        reply: `可选模型：\n${list}\n用 /model <id> 切换；/model default <id> 切换并写成默认。`,
        rich: { markdown: `**可选模型（${ids.length}）：**\n${list}\n用 \`/model <id>\` 切换；\`/model default <id>\` 切换并写成默认。` },
      };
    }
    case 'workspace': {
      const seat = ctx.kernel.setWorkspace;
      // No seat: the honest answer. Saying "已切换" here would be the exact
      // failure this command family exists to avoid — a reply that reads as
      // done while the kernel never moved.
      if (seat === undefined) return { reply: '这个进程没有工作区座位，换工作区请在界面里操作。' };
      try {
        await seat(command.dir ?? '');
      } catch (err) {
        // The kernel owns validation (missing / not a directory / inside
        // `~/.noa`); this only phrases its refusal for a chat window.
        return { reply: `工作区未切换：${errMessage(err)}` };
      }
      return { reply: `工作区已切到 ${ctx.kernel.rootDir()}。` };
    }
    case 'new': {
      // Created through the injected seam, so the peer→session map stays in ONE
      // place (the bridge's) instead of a second copy here.
      const nextAgent = await ctx.newSession();
      return { reply: '已为这个对话开一个新会话，后面的消息走新会话。', nextAgent };
    }
    case 'sessions': {
      const relay = ctx.relay;
      if (relay === undefined) return { reply: '这个进程没有会话接力的座位：它只服务自己的会话。' };
      const candidates = await relay.list();
      if (candidates.length === 0) return { reply: '现在没有活着的会话。' };
      const rows = candidates.map((candidate) => {
        // The row is read in the order a person scans it: what the conversation
        // is about, then its state, then where and when it happened, and the
        // handle LAST — so the hint below can point at one position instead of
        // describing a shape, and so the leading text is never a machine token.
        const marks = [candidate.mine ? '[本对话]' : '', candidate.busy ? '[进行中]' : ''].filter((m) => m.length > 0);
        const what = rowTitle(candidate.title);
        const parts = [what, ...marks, candidate.where, stampOf(candidate.at), candidate.target]
          .filter((part) => part.length > 0);
        return `- ${parts.join(' · ')}`;
      });
      return {
        reply: `📋 活着的会话（${candidates.length}）：\n${rows.join('\n')}\n用 /use <句柄> 把本对话接到其中一个上——句柄是每行最后那段。`,
        rich: {
          markdown: `**📋 活着的会话（${candidates.length}）：**\n${rows.join('\n')}\n用 \`/use <句柄>\` 接到其中一个——句柄是每行最后那段。`,
        },
      };
    }
    case 'use': {
      const relay = ctx.relay;
      if (relay === undefined) return { reply: '这个进程没有会话接力的座位：它只服务自己的会话。' };
      const outcome = await relay.use(command.target);
      if (!outcome.ok) return { reply: `没有切换：${outcome.reason}` };
      const { candidate } = outcome;
      // Name what it landed on, not just where: the confirmation is the reader's
      // only check that they picked the conversation they meant to.
      const what = labelOf(candidate.title);
      const details = [candidate.where, stampOf(candidate.at), candidate.target].filter((part) => part.length > 0);
      return {
        reply: `本对话现在接到 ${what.length > 0 ? `「${what}」` : '（还没说过话）'}（${details.join(' · ')}）${candidate.busy ? '，它正在跑一轮任务——你的下一条消息会排在它后面。' : '。'}`,
      };
    }
    case 'unbind': {
      const relay = ctx.relay;
      if (relay === undefined) return { reply: '这个进程没有会话接力的座位：它只服务自己的会话。' };
      const bound = relay.bound();
      await relay.unbind();
      return {
        reply: bound === undefined
          ? '本对话本来就没有接在别人的会话上。'
          : `已放开 ${bound.target}；本对话会从自己的一个空会话重新开始。`,
      };
    }
    case 'stop': {
      // Read BEFORE aborting: afterwards `running` is already false, and a reply
      // built from the post-state could not tell "I stopped it" from "nothing was
      // running" — two answers the peer acts on differently.
      const wasRunning = ctx.session.running();
      ctx.session.abort();
      return {
        reply: wasRunning
          ? '已中止这一段会话正在跑的任务。'
          : '这一段会话现在没有在跑的任务（若它在等审批或提问，用 /deny 或 /answer 处理）。',
      };
    }
    case 'answer':
      // ONE settle path, two doors: a plain message that arrived while the
      // question waited lands in the same function (`PeerTurns.run`), so a typed
      // number, a tapped button and a sentence of prose cannot disagree.
      return {
        reply: answerPendingQuestion(
          ctx.session.pendingQuestions(),
          (id, answer) => ctx.session.resolveQuestion(id, answer),
          command.text,
        ),
      };
    case 'approve': {
      const first = ctx.session.pendingApprovals()[0];
      if (first === undefined) return { reply: '现在没有待审批的命令。' };
      // A denial carries the reason the model will read, so the remote path states
      // one instead of sending a bare `deny`: the tool result becomes an
      // instruction ("the operator declined"), not an unexplained refusal.
      const answer: AskResult = command.allow ? 'allow' : { answer: 'deny', reason: '操作者从 QQ 拒绝了这条命令' };
      const landed = ctx.session.resolveApproval(first.id, answer);
      if (!landed) return { reply: '这条审批已经不在等待了（可能已超时或被别的入口答复）。' };
      return { reply: command.allow ? `已允许：${first.call.name}` : `已拒绝：${first.call.name}` };
    }
  }
}

