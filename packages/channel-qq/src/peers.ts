/**
 * 对端编排：一条入站消息 → 这个对话**绑定的那段会话** → 回复文本。
 *
 * 这是从前的 `surface/peer.ts`：那时「跑哪一轮」由 surface 编排，因为通道由
 * surface 建。现在通道住在插件自己的 fiber 里（见 `plugin.ts`），所以对端编排也归
 * 插件——surface 只剩「认领 argv 并等通道结束」。
 *
 * 依赖从「内核句柄」换成**能力服务**：会话由 `SessionService` 建/取（它同时把
 * `current` 重绑到这一段，所以内核的审计 / job 扇出 / 压缩目标跟着本轮走），遥控的
 * 座位按有则用、无则如实回答（见 `remote.ts`）。
 *
 * ## 绑定是持久的，这正是本文件存在的理由
 *
 * 每个 QQ 对话绑定到**一份会话日志**（`bindings.ts` 落盘），而不是每次消息现开一段：
 *
 *  - **手机遥控桌面**：对话被接到桌面正在用的那段会话上，于是手机里的一句话**接着**
 *    桌面的上下文走，桌面的转录里也会出现这句话（会话接力）。绑定只存在内存里的话，
 *    一次重启就把接力打断。
 *  - **无 GUI 服务器**：`noa` 重启后，每个对话必须还在原来的那段会话里，否则
 *    每次重启都悄悄从头开始——那正好是这个形态最不想要的东西。
 */
import { errMessage, type AgentSession, type SessionService } from '@noa/core';
import { clampTier, type AccessTier } from './access.js';
import type { BindingsStore } from './bindings.js';
import type { Peer } from './types.js';
import { PendingAsks } from './ask-forward.js';
import { answerPendingQuestion } from './question-answer.js';
import { EMPTY_TURN_LINE } from './progress.js';
import { parseRemoteCommand, splitSlash } from './remote-parse.js';
import { runRemoteCommand, type RelayCandidate, type RemoteKernelPort, type RemoteRelayPort } from './remote.js';
import type { RichSend } from './protocol.js';
import { liveCandidateOf, relayCandidates } from './relay-candidates.js';
import { promptOnce } from './turn.js';
import { turnObserver } from './observer.js';

/** 往 QQ 主动推一行（审批问题与过程回传要用；被动窗口由通道保证）。 */
/** 一条要发回去的回答：文本，加上可选的富样式（markdown 正文 + 按钮）。 */
export interface RemoteAnswer {
  text: string;
  rich?: RichSend;
}

export type PeerNotifier = (peer: Peer, text: string, rich?: RichSend) => void;

/**
 * The kernel's command catalog, as this package sees it.
 *
 * A SEAT rather than a snapshot of names: whether `/compact` exists depends on
 * which plugin rows are loaded, and an operator who switches a plugin off must
 * lose its command in the chat window at the same time as in the browser menu.
 * `run` returns the command's own text because a chat window has nowhere else to
 * put it — the browser reads a `command` event, a peer needs a sentence back.
 */
export interface RemoteCommandSeat {
  /** The live catalog (name only; the help text is built from it). */
  catalog(): readonly { name: string; description: string }[];
  /** Execute one, returning its output; `found: false` means no such command. */
  run(name: string, args: string): Promise<{ found: boolean; text: string }>;
}

/** 对端编排需要的那几件事实（全部来自容器，没有内核句柄）。 */
export interface PeerTurnDeps {
  /** 会话生命周期：绑定与 `current` 的唯一来源。 */
  sessions: SessionService;
  /**
   * 自己新开的会话的落点。缺省 = 内核的默认布局（`newSessionDir()`：标准日期桶），
   * 即本通道开的会话与浏览器开的会话**同一种 nova 会话、同一份目录清单**——
   * WebUI 的会话切换器照常见到它们。通道不再自设隔离目录。
   */
  sessionDir?: string;
  /**
   * 会话目录（`sessionsRoot()`）：接力清单从这里列出**这台机器上的每一段会话**。
   *
   * 本通道自己的会话现在也落在标准日期桶里，目录走查本来就能看到；活句柄那一侧
   * 补的是 `busy` 标记与「本对话正在驱动哪段」。
   */
  catalogDir: string;
  /** The durable chat → session map (see the module header). */
  bindings: BindingsStore;
  /** 本进程的工作区，遥控 `/status` 用；装配没有就给 undefined。 */
  rootDir: () => string | undefined;
  /** 在役模型 id（活读；`llm` 服务缺席时 undefined）。 */
  model: () => string | undefined;
  /** The kernel's slash-command catalog, when this process has one. */
  commands?: RemoteCommandSeat;
  /**
   * The strongest tier a remote peer may take for its own conversation.
   *
   * A THUNK because the operator can lower it in the settings page while a peer
   * is mid-conversation: a ceiling read at construction would keep granting what
   * the page no longer says.
   */
  maxTier?: () => AccessTier;
  /**
   * Whether a question published on these conversations can be answered.
   *
   * Defaulted to `true` because this package now HAS an answer path (`/answer`);
   * an assembly that routes these chats somewhere nobody watches can pass a thunk
   * that says so, and then `ask_user_question` refuses honestly instead of parking
   * a run no card can release.
   */
  canAskUser?: () => boolean;
  notify: PeerNotifier;
  /**
   * 单聊流式消息座位（`stream_messages`）：接线后，一轮里每条助手文本都会边生成
   * 边长在一张卡片上。缺省 = 不流式，叙述与回复照旧走普通发送。
   */
  streamText?: (
    peer: Peer,
    text: string,
    state: 1 | 10,
    index: number,
    streamMsgId?: string,
  ) => Promise<{ streamMsgId?: string } | void>;
  /** 正式回复落地后清扫过程叙述（撤回）；缺省 = 叙述留着。 */
  recallNarration?: (peer: Peer) => void;
  /**
   * 流式卡片中途发不出去时把它撤掉；缺省 = 卡片留着。不撤的代价是读者看到两份：
   * 一段截断且永远收不了口的卡片，加一条回落发出的完整正文。撤回尽力而为。
   */
  recallStream?: (peer: Peer, messageId: string) => Promise<void>;
  /** 现在要不要走流式（断路器）；缺省 = 要。判定与停用时长都归装配层（见 `observer.ts`）。 */
  streamGate?: () => boolean;
  /** 一次流式彻底失败；装配层据此决定要不要断开断路器。 */
  onStreamBroken?: (err: unknown) => void;
  /** 诊断留痕（流式失败等）；缺省 = 静默。 */
  log?: (line: string) => void;
  /**
   * 把本地文件发到某个对端（模型工具入口）。缺省 = 没有这个座位，工具如实说发不了。
   * 只按 `peerId` 走，因为发送只需要被动窗口，不需要 `Peer` 的其它字段。
   */
  sendFile?: (peerId: string, path: string, caption: string) => Promise<void>;
}

/**
 * 对话的会话池：每个 `peerId` 一段，跨消息、跨重启复用。
 *
 * 复用是必须的——QQ 上的一段对话是**同一段对话**，每条消息都开新会话会让模型在
 * 每一行重新失忆。通道把 `brain` 调用全局串行化了，所以不存在两轮同时占着 `current`。
 */
export class PeerTurns {
  /** Live handles by chat, so a turn does not re-look-up the binding every event. */
  private readonly peers = new Map<string, AgentSession>();
  /** 未答复审批的推送 + 兜底（见 `approval.ts`）。 */
  private readonly asks: PendingAsks;
  /** Terminal latch: a disposed pool must not open (or reopen) anything. */
  private disposed = false;

  constructor(private readonly deps: PeerTurnDeps) {
    this.asks = new PendingAsks(deps.notify);
  }

  /**
   * 跑一轮，返回要发回去的文本。
   *
   * Four doors, in this order, and the order is the design:
   *
   *  1. a verb this package OWNS (`/perm`, `/approve`, `/use`, …) — it has kernel
   *     seats the catalog cannot express (approving an outstanding ask, pointing
   *     this chat at somebody else's conversation);
   *  2. a name the KERNEL's live catalog owns (`/compact`, `/goal`, `/mode`, and
   *     anything a third-party plugin registered) — resolved LIVE, so a command
   *     appears here exactly when it is loaded, and switches off with its row;
   *  3. the ANSWER to an outstanding question — a number picks an option and prose
   *     is free text, because a question is settled in the peer's own words. It sits
   *     ahead of the prompt door, and the inbound bypass claims it too: the run is
   *     PARKED inside the question, so a prompt would queue behind the wait it
   *     should release;
   *  4. everything else, verbatim, as a prompt — a chain, not a whitelist, so an
   *     unparsed line is never swallowed.
   * @param text - 入站消息。
   * @param peer - 发消息的 QQ 对端。
   * @returns 回复文本；空串表示「这一轮已经自己把话说完并送出去了」。
   */
  async run(text: string, peer: Peer): Promise<RemoteAnswer> {
    const parsed = parseRemoteCommand(text);
    if (parsed.command !== undefined) return await this.runRemote(parsed.command, peer);
    const slash = splitSlash(text);
    const commands = this.deps.commands;
    if (slash !== undefined && commands !== undefined && this.hasCommand(commands, slash.name)) {
      const outcome = await commands.run(slash.name.slice(1), slash.args);
      return {
        text: outcome.text.length > 0 ? outcome.text : `/${slash.name.slice(1)} 执行完毕（无输出）。`,
      };
    }
    const agent = await this.agentFor(peer);
    const pending = agent.pendingQuestions();
    if (pending.length > 0 && slash === undefined) {
      return { text: answerPendingQuestion(pending, (id, answer) => agent.resolveQuestion(id, answer), text) };
    }
    const observer = turnObserver(peer, this.deps);
    const result = await promptOnce(agent, this.asks, text, peer, observer);
    // The ANSWER is RETURNED, not relayed. `notify` is the NARRATION class, capped
    // below the reply allowance on purpose so a busy turn cannot spend the answer's
    // reserve — so delivering the answer through it made the one message the peer
    // was waiting for the one message that could be dropped. Returning it hands it
    // to the channel's reply seat, which spends the reserve.
    if (result.reply.trim().length === 0) {
      // Nothing to say: the "finished, no text" line is narration, and there is
      // nothing for the caller to deliver. A turn that was CUT SHORT is the one
      // exception: the new message (or `/stop`) that interrupted it is already
      // being answered, so the floor line would answer a question nobody asked.
      if (result.aborted !== true) this.deps.notify(peer, EMPTY_TURN_LINE);
      this.deps.recallNarration?.(peer);
      return { text: '' };
    }
    // Already fully delivered by its streaming card (state 10 with the full
    // text): returning the body would make the peer read the answer twice.
    if (result.streamed === true) {
      this.deps.recallNarration?.(peer);
      return { text: '' };
    }
    // The reply goes out as MARKDOWN: the client renders headings, bold, lists
    // and code instead of raw characters. A plain-text fallback on platform
    // refusal is folded in at the protocol layer, so nothing is lost.
    this.deps.recallNarration?.(peer);
    return { text: result.reply, rich: { markdown: result.reply } };
  }

  /**
   * 插件卸载时的收尾。
   *
   * 在飞的轮次**中止**而不是继续跑：插件关了就该停一切，包括一次正在等模型的调用。
   * 会话本身不销毁——日志是持久事实，而且重建一个 handle 的代价只是重新投影；这里
   * 只放下对它的引用（`current` 由容器管，不由这里管）。审批定时器必须清掉：它们
   * 是这一档激活持有的资源，fiber 走了还在跑就是泄漏。
   */
  dispose(): void {
    this.disposed = true;
    this.asks.dispose();
    for (const agent of this.peers.values()) agent.abort();
    this.peers.clear();
  }

  /**
   * 把本地文件发到**本会话所在的 QQ 对话**（模型工具 `qq_send_file` 的落点）。
   *
   * 对端由「当前会话」反查，不由模型指名——`peerId` 从没告诉过模型，而一个能对任意
   * 对端发消息的工具正是本包刻意不要的东西。所以这里只有一条路：这个会话属于哪个
   * QQ 对话，文件就发到哪；不属于任何 QQ 对话就如实说没发。
   * @param file - 本地路径与可选的说明文字。
   * @returns 给模型看的一句话（成功或为什么没发）。
   */
  async sendFileToCurrentConversation(file: { path: string; caption?: string }): Promise<string> {
    const current = this.deps.sessions.current();
    if (current === undefined) return '当前没有活动会话，文件未发送。';
    const match = [...this.peers.entries()].find(([, agent]) => agent.session.file === current.session.file);
    if (match === undefined) {
      return '这个会话不是 QQ 对话（没有绑定的对端），文件仍在本地、没有发送。';
    }
    const send = this.deps.sendFile;
    if (send === undefined) return '这个进程没有发送文件的座位，文件未发送。';
    try {
      await send(match[0], file.path, file.caption ?? '');
      return `已发送到当前 QQ 对话：${file.path}`;
    } catch (err) {
      return `发送失败：${errMessage(err)}`;
    }
  }

  /**
   * 打断这个对端正跑着的那一轮（有则 true）。
   *
   * 与 `/stop` 是同一个动作，只是触发者不同：那边是操作者点名要停，这边是一条新消息
   * 到了——两者都走 `AgentSession.abort()`，不另造一条「怎么停」的路。
   */
  interrupt(peer: Peer): boolean {
    const agent = this.peers.get(peer.peerId);
    if (agent === undefined || !agent.running) return false;
    agent.abort();
    return true;
  }

  /**
   * 这个对端的会话是不是正停在一个提问上（同步，因为入站旁路必须无 IO 地决定）。
   * 入站侧拿它判断「这句普通话是不是答复」：是的话必须走队列**之外**的旁路，否则
   * 它会排在自己所等的那一轮后面——与审批答复是同一个死锁（`run` 的第三道门是它
   * 的执行侧）。
   */
  awaitingQuestion(peer: Peer): boolean {
    const agent = this.peers.get(peer.peerId);
    return agent !== undefined && agent.pendingQuestions().length > 0;
  }

  /** Is this `/name` one the kernel currently owns? (Re-read per call: rows flip.) */
  private hasCommand(seat: RemoteCommandSeat, slashName: string): boolean {
    const name = slashName.slice(1);
    return name.length > 0 && seat.catalog().some((entry) => entry.name === name);
  }

  /** 执行一条遥控指令（在通道的旁路里跑，不占串行队列）。 */
  private async runRemote(
    command: NonNullable<ReturnType<typeof parseRemoteCommand>['command']>,
    peer: Peer,
  ): Promise<RemoteAnswer> {
    const agent = await this.agentFor(peer);
    const kernel: RemoteKernelPort = {
      rootDir: () => this.deps.rootDir() ?? '',
      // The model in force is KNOWABLE (the `llm` service publishes it) even
      // though no plugin can SWITCH it: nothing publishes a model catalog to
      // plugins, so `/status` reports the id and `/model` answers honestly that
      // this process has no switching seat (see `remote.ts`).
      model: () => this.deps.model(),
    };
    const outcome = await runRemoteCommand(command, {
      kernel,
      session: {
        setApprovalMode: (mode) => { agent.setApprovalMode(mode); },
        approvalMode: () => agent.approvalMode,
        pendingApprovals: () => agent.pendingApprovals(),
        resolveApproval: (id, answer) => agent.resolveApproval(id, answer),
        abort: () => { agent.abort(); },
        running: () => agent.running,
        pendingQuestions: () => agent.pendingQuestions(),
        resolveQuestion: (id, answer) => agent.resolveQuestion(id, answer),
      },
      maxTier: this.deps.maxTier?.(),
      relay: this.relayPort(agent, peer),
      // `/new` runs through the ONE command implementation, which hands the new
      // session back; rebinding happens here, where the peer map lives, instead of
      // a second `/new` branch in this class.
      newSession: () => this.newSession(peer),
    });
    if (outcome.nextAgent !== undefined) this.peers.set(peer.peerId, outcome.nextAgent);
    return { text: outcome.reply, ...(outcome.rich !== undefined ? { rich: outcome.rich } : {}) };
  }

  /**
   * The relay seat: which OTHER conversations this chat may be pointed at.
   *
   * The rows themselves are built in `relay-candidates.ts` (two sources, merged
   * and sorted); this only decides what a CHOICE does — bind the log, and keep the
   * peer map honest about whether anyone holds it.
   *
   * `mine` is computed against the handle this chat currently drives, so the
   * listing answers "where am I" as well as "what else is there" — a peer who
   * cannot see which conversation they are in cannot safely `/use` another.
   */
  private relayPort(current: AgentSession, peer: Peer): RemoteRelayPort {
    const mineFile = current.session.file;
    const candidatesFor = (): Promise<RelayCandidate[]> =>
      relayCandidates({ live: this.deps.sessions.list(), catalogDir: this.deps.catalogDir, mineFile });

    return {
      list: candidatesFor,
      use: async (target) => {
        const candidates = await candidatesFor();
        const matches = candidates.filter(
          (candidate) => candidate.id.startsWith(target) || candidate.target === target,
        );
        if (matches.length === 0) {
          return { ok: false, reason: `清单里没有 ${target}（用 /sessions 看当前清单）。` };
        }
        // Ambiguity is refused rather than resolved by picking the first: the peer
        // asked for one conversation and silently attaching them to another is
        // exactly the "switch that landed somewhere else" this command exists to
        // avoid.
        if (matches.length > 1) return { ok: false, reason: `${target} 匹配到 ${matches.length} 个会话，请多打几位。` };
        const chosen = matches[0];
        if (chosen === undefined) return { ok: false, reason: '内部错误：匹配到的会话不见了。' };
        await this.bind(peer, { kind: 'relay', file: chosen.file });
        // Only a LIVE handle goes in the map. Binding to a log nobody holds must
        // leave the map without one, so the next turn resumes it from the file —
        // opening a second handle on one log would put two writers on it, which is
        // the invariant `agentFor` exists to keep.
        const held = this.deps.sessions.list().find((agent) => agent.session.file === chosen.file);
        if (held === undefined) this.peers.delete(peer.peerId);
        else this.peers.set(peer.peerId, held);
        // Binding a relay does NOT steal the kernel's `current`: the selection a
        // desktop is showing belongs to the desktop. `activate` happens per turn,
        // in `agentFor`, so audit and job fan-out follow the turn being run.
        return { ok: true, candidate: chosen };
      },
      unbind: async () => {
        await this.deps.bindings.clear(peer.peerId);
        this.peers.delete(peer.peerId);
      },
      bound: () => {
        const binding = this.deps.bindings.get(peer.peerId);
        if (binding === undefined || binding.kind !== 'relay') return undefined;
        return liveCandidateOf(current, mineFile);
      },
    };
  }

  /**
   * 取（或懒建）这个对话的会话，并让 `current` 跟着本轮走。
   *
   * The order matters and is the whole point of the durable binding: an ALREADY
   * LIVE handle for the bound log wins, because opening a second handle on one log
   * puts two writers on it. Only when nobody holds it does this resume from the
   * file — which is how a restart rejoins the same conversation.
   */
  private async agentFor(peer: Peer): Promise<AgentSession> {
    const bound = this.deps.bindings.get(peer.peerId);
    if (bound !== undefined) {
      const live = this.deps.sessions.list().find((agent) => agent.session.file === bound.file);
      if (live !== undefined) {
        this.peers.set(peer.peerId, live);
        this.deps.sessions.activate(live);
        return live;
      }
      const held = this.peers.get(peer.peerId);
      if (held !== undefined && held.session.file === bound.file && !held.disposed) {
        this.deps.sessions.activate(held);
        return held;
      }
      return await this.resume(peer, bound);
    }
    const existing = this.peers.get(peer.peerId);
    if (existing !== undefined && !existing.disposed) {
      this.deps.sessions.activate(existing);
      return existing;
    }
    return await this.newSession(peer);
  }

  /** Reopen a bound log, keeping the binding's kind (a relay stays a relay). */
  private async resume(peer: Peer, bound: { kind: 'own' | 'relay'; file: string }): Promise<AgentSession> {
    const agent = await this.open({ resumeFile: bound.file });
    // A conversation this chat OWNS is subject to the remote ceiling like a fresh
    // one; a RELAY is somebody else's conversation and must not be re-tiered.
    if (bound.kind === 'own') this.capOwnedTier(agent);
    this.peers.set(peer.peerId, agent);
    // The file can change on resume in principle (it does not today, but the
    // binding is the durable fact and must record what actually opened).
    if (agent.session.file !== bound.file) await this.bind(peer, { kind: bound.kind, file: agent.session.file });
    return agent;
  }

  private async newSession(peer: Peer): Promise<AgentSession> {
    const agent = await this.open({});
    this.capOwnedTier(agent);
    this.peers.set(peer.peerId, agent);
    await this.bind(peer, { kind: 'own', file: agent.session.file });
    return agent;
  }

  /**
   * Clamp a conversation this chat OWNS to the channel's tier ceiling.
   *
   * `maxTier` used to be enforced only on `/perm`, so it governed the VERB and not
   * the execution: a machine running at `full` (`config.approval`) handed every
   * bound peer a `full` conversation, and the operator's ceiling did nothing until
   * the peer happened to type `/perm`. The tier is a per-session fact, so it is
   * clamped at the moment the conversation is created.
   *
   * Deliberately NOT applied to a RELAYED conversation: lowering a desktop
   * session's tier because a phone pointed at it would let the remote ceiling
   * contaminate the desktop. Capping a relayed call needs the ceiling to travel
   * with the CALLER (a per-call principal), which this channel does not have yet.
   * @param agent - the conversation just opened for this chat.
   */
  private capOwnedTier(agent: AgentSession): void {
    const ceiling: AccessTier = this.deps.maxTier?.() ?? 'read-only';
    const mode = agent.approvalMode;
    if (mode === undefined) return;
    const capped = clampTier(mode, ceiling);
    if (capped !== mode) agent.setApprovalMode(capped);
  }

  /**
   * Open through the service, which is what makes this the current session.
   *
   * `canAskUser: () => false` is not a policy this file invents: a bot peer has
   * nobody watching ITS stream, so a question card published here would park the
   * run with nothing able to release it. Refusing is what makes
   * `ask_user_question` answer the model honestly instead.
   */
  private async open(options: { resumeFile?: string }): Promise<AgentSession> {
    if (this.disposed) {
      // A pool that has been torn down must not start new work: the plugin that
      // owned it is gone, so a conversation opened here would have no surface.
      throw new Error('qqbot: this conversation pool was disposed');
    }
    return await this.deps.sessions.open({
      // 无自设目录 = 内核默认的 `newSessionDir()`（标准日期桶）：本通道的会话
      // 与交互会话同布局、同清单，WebUI 切换器照常列出。
      ...(this.deps.sessionDir !== undefined ? { sessionDir: this.deps.sessionDir } : {}),
      ...(options.resumeFile !== undefined ? { resumeFile: options.resumeFile } : {}),
      // A chat peer CAN be asked: questions are forwarded to it and answered by
      // replying (`question-answer.ts` maps the prose onto the kernel's batch).
      // This used to be `false`, which made every question refuse with
      // NO_PROVIDER — honest, but it meant the agent could never ask the person
      // who was right there in the chat window.
      canAskUser: () => this.deps.canAskUser?.() ?? true,
    });
  }

  private async bind(peer: Peer, binding: { kind: 'own' | 'relay'; file: string }): Promise<void> {
    await this.deps.bindings.set(peer.peerId, binding);
  }
}
