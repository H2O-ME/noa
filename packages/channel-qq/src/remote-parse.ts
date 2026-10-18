/**
 * 遥控指令的**纯解析器**：QQ 对端发来的一行文本 → 一条意图（或「不是指令」）。
 *
 * 为什么单独一个文件、且不碰任何内核对象：QQ 那边输入的是**文本**，所以「这句话是
 * 指令还是普通提示词」必须是一个可以直接驱动、不用起会话/不用起网络就能穷举的函数。
 * 内核的接缝（权限档、审批、换模型、换工作区、开新会话）在 `remote.ts` 里接线，
 * 这里只负责**认字**。
 *
 * 纪律与前端斜杠菜单完全相同（`ui/src/composer/command-menu.ts`）：认得的 `/name`
 * 当指令走，**认不得的一律原样当提示词发出去**。这条是整个设计的落点——操作者不需要
 * 学两套语法，也不需要担心哪句话被系统吞掉。所以这里刻意**只**认下面的白名单，
 * 且**大小写敏感**（`/Perm` 是普通文本，不是指令）。
 */

/** 权限档位（与内核 `ApprovalMode` 同词汇：auto = 智能审批，full = 全放行）。 */
export type RemotePerm = 'auto' | 'full';

/** 一条认得出的遥控指令。 */
export type RemoteCommand =
  | { kind: 'perm'; mode: RemotePerm }
  /**
   * 切换模型。`persist` 表示**同时**把它写成这个部署的默认（`/model default <id>`）：
   * 切换改的是这个进程的 client，写默认改的是配置文件，好让下次启动仍从那里开始 ——
   * 两件都做了才叫「改默认模型」。
   */
  | { kind: 'model'; model: string; persist?: boolean }
  | { kind: 'models' }
  | { kind: 'workspace'; dir?: string }
  | { kind: 'new' }
  | { kind: 'help' }
  | { kind: 'approve'; allow: boolean }
  | { kind: 'status' }
  /**
   * What this conversation has spent so far: token totals, plus money when the
   * deployment priced its models.
   *
   * A READ that earns a verb of its own rather than a line inside `/status`: a
   * resident bot runs for weeks, so "what has this cost me" is a question about a
   * number that keeps growing, and an answer buried among four other facts is one
   * nobody asks twice.
   */
  | { kind: 'usage' }
  /**
   * Take back the last `turns` turns, so the model stops seeing them.
   *
   * The log keeps them (a rewind SHADOWS the surface, it does not delete) — which
   * is what makes this safe to offer from a phone: a mis-typed `/undo 3` costs the
   * peer three turns of context, not three turns of transcript.
   */
  | { kind: 'undo'; turns: number }
  /**
   * Say the last thing again from a clean slate: take back the last turn and
   * re-send the prompt that opened it.
   *
   * A verb of its own rather than `/undo 1` plus a re-typed message because the
   * re-typed message would be a SECOND prompt with its own text — and the whole
   * point is to re-ask the SAME question, which is the one thing a chat window
   * cannot easily reproduce once it has scrolled.
   */
  | { kind: 'retry' }
  /**
   * Session RELAY: see which conversations are alive, point this chat at one, or
   * let go of it. This is the phone-driving-a-desktop half of the channel — a
   * message from the phone must land in the SAME conversation the desktop is
   * working in, so the agent keeps its context instead of starting over.
   */
  | { kind: 'sessions' }
  | { kind: 'use'; target: string }
  | { kind: 'unbind' }
  /** Interrupt the bound conversation's run — the remote equivalent of Ctrl+C. */
  | { kind: 'stop' }
  /**
   * Answer the outstanding `ask_user_question` with free text.
   *
   * A chat window has no form to fill: the peer sees a numbered menu and types
   * numbers, or types prose and it becomes a free-text answer. The mapping lives in
   * `question-answer.ts`, and this verb exists so the text is unambiguously an
   * ANSWER — a bare message during a parked question could just as well be a new
   * request, and guessing between the two is how a question eats the peer's next
   * instruction.
   */
  | { kind: 'answer'; text: string };

/** 解析结果：要么一条指令，要么（原样）当提示词。 */
export type RemoteParse =
  | { command: RemoteCommand; text?: undefined }
  | { command?: undefined; text: string };

/** The permission tiers a peer may choose, in the order the help text lists them. */
export const REMOTE_PERM_MODES: readonly RemotePerm[] = ['auto', 'full'];

/**
 * A `/name args` line, split the ONE way.
 *
 * Exported because a second reader needs the same answer: the catalog path
 * (`PeerTurns` asks "is this a kernel command?") and this parser must agree on
 * where the name ends, or `/goal 新目标` would be looked up as `goal` in one place
 * and `goal 新目标` in the other. Splitting it here keeps the syntax in one file.
 * @param text - the inbound line, verbatim.
 * @returns the name (with its leading `/`) and the rest, or undefined when the
 *   first token is not a slash name.
 */
export function splitSlash(text: string): { name: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const space = trimmed.search(/\s/u);
  const name = space < 0 ? trimmed : trimmed.slice(0, space);
  const args = space < 0 ? '' : trimmed.slice(space).trim();
  // `/` alone is not a name, and a name that is only punctuation (`//`, `/-`) is
  // not something any catalog can hold — treating it as a prompt keeps the
  // "never swallow the operator's text" rule intact.
  return name.length > 1 ? { name, args } : undefined;
}

/**
 * Whether one command must run OUTSIDE the serial per-peer queue.
 *
 * The bypass exists for exactly one deadlock: a turn parked on an approval can
 * only be released by an answer, so an answer that queued behind that turn would
 * wait for itself — and so would a TIER change: the whole point of raising the
 * tier from the phone is to stop being asked, so a `/perm` parked behind the very
 * ask it should have prevented is the same deadlock in a different coat.
 * Everything else BELONGS in the queue — a new session or a catalog command that
 * mutates state must not run concurrently with a turn.
 *
 * Reads and unblock-actions only, therefore, and the list is derived from the
 * parsed command rather than re-parsed from text.
 * @param command - one parsed QQ verb.
 * @returns true when it may skip the queue.
 */
export function remoteBypassesQueue(command: RemoteCommand): boolean {
  switch (command.kind) {
    case 'approve':
    case 'status':
    case 'usage':
    case 'help':
    case 'sessions':
    // All three are UNBLOCKING: `/stop` exists to release a run that is parked
    // or spinning, `/answer` releases the very wait `/stop` would otherwise be
    // needed for, and `/perm` is the third way out of the same park — stop being
    // asked at all. Queueing any of them behind the run they are meant to release
    // is the deadlock the bypass exists to prevent.
    case 'stop':
    case 'answer':
    case 'perm':
      return true;
    case 'model':
    case 'models':
    case 'workspace':
    case 'new':
    case 'use':
    case 'unbind':
      return false;
    case 'undo':
    case 'retry':
      // The opposite of the unblocking verbs, and the reason is the same: these
      // MUTATE the surface. An undo spliced in beside a live turn would take back
      // a turn the running request is still building from, so it belongs in the
      // queue — where it lands after the turn it is undoing, which is also the
      // only order that makes sense to the peer.
      return false;
  }
}

/** 「不是指令」：整行按普通提示词送进会话。 */
function asPrompt(text: string): RemoteParse {
  return { text };
}

/** 一条指令。 */
function asCommand(command: RemoteCommand): RemoteParse {
  return { command };
}

/**
 * `/undo` 的论元：缺省一轮，只接受正整数。
 *
 * Split out because it is the one verb with a numeric argument, and the rules for
 * it are the verb's own rather than the dispatcher's: "no argument" is a default
 * while "0 / -1 / 2.5 / 1 2" are usage mistakes that must become a PROMPT rather
 * than a silent one — reading `/undo 0` as "undo one" would take back a turn the
 * peer did not ask for.
 * @param rest - the text after the verb, already trimmed.
 * @returns the turn count, or undefined when the argument is a usage mistake.
 */
function undoArgument(rest: string): number | undefined {
  if (rest.length === 0) return 1;
  if (!/^\d+$/u.test(rest)) return undefined;
  const turns = Number.parseInt(rest, 10);
  return turns >= 1 ? turns : undefined;
}

/**
 * The verbs that take no argument at all: the name IS the whole command.
 *
 * A table rather than one `case` per verb, because the fact these share is one
 * fact — "an argument here is not a variant, it is noise" — and spelling it eight
 * times hid it. It also keeps the dispatcher below proportional to the verbs that
 * genuinely have ARGUMENTS to interpret, which is where the rules live.
 */
const BARE_VERBS: ReadonlyMap<string, RemoteCommand> = new Map<string, RemoteCommand>([
  ['/new', { kind: 'new' }],
  // Listing is a read: it changes which conversation this chat drives NOTHING, so
  // it never needs an argument.
  ['/sessions', { kind: 'sessions' }],
  ['/unbind', { kind: 'unbind' }],
  ['/stop', { kind: 'stop' }],
  ['/status', { kind: 'status' }],
  // A readout: "how much have I spent" has no sub-question a word here would
  // disambiguate.
  ['/usage', { kind: 'usage' }],
  // "Redo the last turn" is the whole verb.
  ['/retry', { kind: 'retry' }],
  ['/help', { kind: 'help' }],
]);

/**
 * Parse one inbound line.
 *
 * Only a line whose FIRST token starts with `/` is ever considered a command;
 * everything else is a prompt. Unknown `/…` names are ALSO returned as prompts
 * (see the module header) — the failure mode of a typo must be "the agent was
 * asked something odd", never "my message vanished".
 *
 * A name this parser does not own may still be a command the KERNEL owns
 * (`/compact`, `/goal`, `/mode`, anything a third-party plugin registered). The
 * parser deliberately does not decide that: it cannot see the catalog, and a
 * hardcoded copy of it would drift. The caller resolves unknown names against the
 * LIVE catalog (see `splitSlash`) and only then falls back to a prompt.
 * @param raw - the inbound text, verbatim.
 * @returns the command, or the text to send as a prompt.
 */
export function parseRemoteCommand(raw: string): RemoteParse {
  const slash = splitSlash(raw);
  if (slash === undefined) return asPrompt(raw);
  const { name, args: rest } = slash;
  const bare = BARE_VERBS.get(name);
  if (bare !== undefined) return asCommand(bare);
  switch (name) {
    case '/perm':
    case '/approvals':
      // `/approvals` is the same verb under the name the hermes-style peer
      // reaches for; two spellings, one tier switch.
      return REMOTE_PERM_MODES.includes(rest as RemotePerm)
        ? asCommand({ kind: 'perm', mode: rest as RemotePerm })
        : asPrompt(raw);
    case '/model': {
      // An absent id asks a question (list them) rather than being a no-op.
      if (rest.length === 0) return asCommand({ kind: 'models' });
      // `/model default <id>`：切换**并**写成默认。子命令而不是 `--flag`，因为聊天里
      // 打错一个 `--` 比打错一个词更容易被忽略，而这条指令会改配置文件。
      const [head, ...tail] = rest.split(/\s+/);
      // 光一个 `default` 没带 id：操作者想说「改默认」但没说改成哪个。回一份可选清单
      // （和裸 `/model` 同一个回答），比「没有名为 default 的模型」有用得多 —— 后者会
      // 让人以为指令写对了、只是模型不存在。
      if (head === 'default') {
        return tail.length > 0
          ? asCommand({ kind: 'model', model: tail.join(' '), persist: true })
          : asCommand({ kind: 'models' });
      }
      return asCommand({ kind: 'model', model: rest });
    }
    case '/ws':
      // A workspace move with no argument reports where it is; the kernel's
      // `setWorkspace` validates a real path, and guessing one here would hide
      // its refusal.
      return rest.length === 0 ? asCommand({ kind: 'status' }) : asCommand({ kind: 'workspace', dir: rest });
    case '/use':
      // No argument is a usage mistake, not a "list them" question: `/sessions` is
      // the listing verb, and answering a different question here would teach the
      // peer the wrong command.
      return rest.length === 0 ? asPrompt(raw) : asCommand({ kind: 'use', target: rest });
    case '/answer':
      // Empty is a usage mistake: an answer with nothing in it is not an answer.
      return rest.length === 0 ? asPrompt(raw) : asCommand({ kind: 'answer', text: rest });
    case '/undo': {
      const turns = undoArgument(rest);
      return turns === undefined ? asPrompt(raw) : asCommand({ kind: 'undo', turns });
    }
    case '/approve':
    case '/deny':
      return asCommand({ kind: 'approve', allow: name === '/approve' });
    default:
      // An UNKNOWN `/name` is a prompt, matching the composer's rule: the peer's
      // text is never swallowed by a parser that did not understand it.
      return asPrompt(raw);
  }
}
