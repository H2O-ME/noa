import type {
  ApprovalAudit,
  ApprovalMode,
  ApprovalPolicy,
  AskAnswer,
  AskFn,
  AskResult,
  DecideResult,
  ToolCall,
  ToolPermissionKind as PermissionKind,
} from '@noa/core';
import { alwaysScopeWords, commandProgram, parseAskResult } from '@noa/core';

/**
 * The approval vocabulary lives in core (the kernel event stream speaks it:
 * `approval_request` / `resolveApproval`), including the rule that produces an
 * "always" grant's scope options — re-exported here so the historical
 * `@noa/plugins` import sites keep working verbatim.
 */
export { alwaysScopeWords };
export type {
  ApprovalMode,
  AskAnswer,
  AlwaysGrant,
  DenyGrant,
  AskResult,
  AskFn,
  DecideResult,
  ApprovalPolicy,
  ApprovalAudit,
} from '@noa/core';

/**
 * Fail-closed normalization for the asker seam: an asker is third-party code
 * handing back `unknown`, so its answer goes through core's one answer parser
 * (`parseAskResult`) and anything malformed denies the call.
 */
function normalizeAsk(raw: unknown): AskResult {
  return parseAskResult(raw) ?? 'deny';
}

/**
 * Two-tier approval:
 * - auto: reads, in-workspace writes and network READS are auto-allowed;
 *   `execute` and `read-external` ask — which in this product means the SMART
 *   gate (a reviewer model, with a human only when the reviewer is unsure). See
 *   `reviewer.ts`. What the gate protects is the machine and the operator's own
 *   files, not the act of looking something up (see `autoAllows`).
 * - full: everything allowed.
 *
 * Writes are always inside the workspace root (the fs tools resolve through
 * `resolveInRoot`, which refuses to escape it), so `write` IS the
 * "workspace write" the tier means; there is no out-of-root write to gate.
 *
 * An "always" answer is remembered for the rest of the session, scoped to
 * WHAT was approved (dsh's allowed-once lesson, one notch looser):
 * - execute tools are remembered by the command's program prefix
 *   (`exec:git`), so `git status` approves later `git ...` commands but not
 *   `rm -rf`;
 * - other kinds are remembered per tool name + kind.
 *
 * An asker may pin the scope tighter/looser (组件6, Grok 可调 always 范围):
 * `alwaysScopeWords` 给出可选词数，`{answer:'always', scopeWords:N}` 把记忆
 * 钉在命令前 N 词（`git status` → 放行 `git status …`，不波及 `git commit`）。
 * N 越界或命令是复合式时回落默认范围——授权范围永远由引擎校验，不由询问器自定。
 *
 * All failure modes fail closed: a throwing asker or an invalid answer
 * denies the call instead of opening the gate.
 */
/**
 * The process-wide approval policy, as one mutable cell.
 *
 * `'never'` is a statement about the PROCESS ("there is no interactive answerer
 * here"), not about a conversation, so every session's engine reads and writes
 * the SAME cell. Sharing it by reference is what lets a headless runner pin
 * `never` once — before or after sessions exist — and have every session it
 * creates inherit that, without any of them being able to disagree with the
 * others about whether a human is reachable.
 */
export interface ApprovalPolicyCell {
  policy: ApprovalPolicy;
}

export class PermissionService {
  /** Remembered grants, keyed by scope (see rememberKey). */
  private readonly remembered = new Set<string>();
  private mode: ApprovalMode;
  /**
   * Serialization point for the ask path: concurrent decide() calls dispatch
   * their asker ONE AT A TIME. Without this, PTC run_code's parallel sub-calls
   * race for the approval modal — each ask overwrites `store.approval`,
   * the displaced promise never resolves, and the run hangs forever. Verdict
   * short-circuits (remembered / auto-allow / 'never') bypass the chain.
   */
  private askChain: Promise<unknown> = Promise.resolve();

  constructor(
    mode: ApprovalMode,
    private readonly ask: AskFn,
    private readonly audit?: (entry: ApprovalAudit) => void,
    /**
     * The shared policy cell. Defaulted so a standalone engine (a test, an
     * embedder) still works, but a kernel passes its ONE cell to every session
     * engine it builds — see `ApprovalPolicyCell`.
     */
    private readonly policyCell: ApprovalPolicyCell = { policy: 'ask' },
  ) {
    this.mode = mode;
  }

  get approvalMode(): ApprovalMode {
    return this.mode;
  }

  /** Runtime switch (e.g. the /perm command). Per session, not per kernel. */
  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /** Non-interactive deployments set this once; 'never' short-circuits every ask. */
  setPolicy(policy: ApprovalPolicy): void {
    this.policyCell.policy = policy;
  }

  get approvalPolicy(): ApprovalPolicy {
    return this.policyCell.policy;
  }

  private autoAllows(kind: PermissionKind): boolean {
    if (this.mode === 'full') return true;
    if (kind === 'read') return true;
    // In-workspace writes are the ordinary way a coding agent works, and the
    // workspace is the operator's own project directory: there is nothing here
    // for the gate to weigh. This stays honest only because `write-external`
    // exists — the fs write tools grade each call against the root
    // (`rootWriteKind`), so a path that leaves the workspace arrives below as a
    // DIFFERENT kind rather than as a `write`.
    if (kind === 'write') return true;
    // 联网**读**：抓一个 URL 改不了这台机器上的任何东西，而「查一下」正是操作者要的事。
    // 把它挡在闸门后，等于每一次查资料都把整轮运行停住等一张卡 —— 对一个无人值守、只在
    // 手机上看的 bot 来说这是最糟的失败模式（超时即拒，而人可能几小时后才看见），而且它
    // 并不是这道闸门存在的理由。
    //
    // Hermes 把线划在同一个位置：它的审批管 bash 命令与文件写入
    // （`tools/approval_floors.py`、`file_tools_write_guards.py`），联网工具**从不**过闸
    // （`tools/web_tools.py` 里没有任何 approval 引用）；出网安全靠 `tools/url_safety.py`
    // 加一份**可选**的站点黑名单，而不是靠打断运行去问人。Noa 的对应物是
    // `isSafeHttpUrl`（每一跳都过，只允许公网 http/https）。
    //
    // 残余风险写在这里而不是藏着：联网读自动放行，加上工作区文件本就可自动读，意味着一个
    // 被注入的页面能诱导模型把工作区内容塞进 URL 发出去。Hermes 同样如此（它的联网工具也
    // 不过闸），所以这不是本产品新开的口子；要收紧，扩展点是站点黑名单，不是把每一次抓取
    // 都变成一张卡。
    //
    // 注意这条只管**读**：将来若有会**发送**数据的联网工具（上传、发帖、改远端状态），
    // 那属于 `execute` 那一类，不要复用这个种类。
    if (kind === 'network') return true;
    // `read-external` and `write-external` reach into the operator's own files
    // outside the workspace, and `execute` can do anything: all three go to the
    // gate in `auto`.
    //
    // `write-external` is the one that used to be a hard refusal instead (the fs
    // tools threw `path escapes workspace root`). That read as a broken tool on a
    // server-resident deployment, where the machine IS the operator's and the
    // "wall" was never real — `bash` runs as the same user and was never confined
    // by it. Reviewed-not-refused is the honest version of the same boundary.
    return false;
  }

  /**
   * The scope an "always" grant covers for this call: a bare command is
   * remembered per program prefix; a COMPOUND command is remembered as the
   * whole normalized command. Compound means explicit chaining (`&&`/`;`/`|`
   * /`&`), newline chains (bash executes lines sequentially — a multi-line
   * `echo\nrm -rf` would otherwise be remembered as plain `exec:echo`) AND
   * command substitution (`$(...)`/backtick: the user approved a program, not
   * an arbitrary payload it happens to interpolate). Granting `exec:cd` from
   * `cd x && rm -rf .` would let any `cd` skip the gate, so these stay
   * single-shot: only that exact command (modulo whitespace) is re-granted.
   */
  private rememberKey(toolName: string, kind: PermissionKind, call: ToolCall): string {
    if (kind === 'execute') {
      const command = typeof call.args['command'] === 'string' ? call.args['command'].trim() : '';
      if (command.length > 0) {
        // The PROGRAM, not the raw first token (see commandProgram): a leading
        // `NAME=value` prefix must not become the grant key, or `NOVA=1 git
        // status` would remember `exec:nova=1` and silently allow a later
        // `NOVA=1 rm -rf ~`. Compound / all-assignment commands have no single
        // program, so the whole normalized command is the key — only that exact
        // command is re-granted.
        const program = commandProgram(command);
        if (program !== undefined) return `exec:${program}`;
        return `exec:${command.replace(/\s+/g, ' ')}`;
      }
    }
    return `${toolName}:${kind}`;
  }

  /**
   * The grant scope the user pinned with ←/→ (组件6): first N words of the
   * command, program lowercased like the default key. undefined when N runs
   * past the words or the command has no word-prefix semantics (compound).
   */
  private scopeKey(kind: PermissionKind, call: ToolCall, n: number): string | undefined {
    if (kind !== 'execute') return undefined;
    const words = alwaysScopeWords(call.args['command']);
    if (words.length === 0 || n > words.length) return undefined;
    const [first, ...rest] = words;
    return `exec:${[(first ?? '').toLowerCase(), ...rest.slice(0, n - 1)].join(' ')}`;
  }

  /** Any remembered word-prefix (2..N words) covering this bare command. */
  private scopeHit(call: ToolCall): boolean {
    const words = alwaysScopeWords(call.args['command']);
    for (let n = 2; n <= words.length; n++) {
      if (this.remembered.has(this.scopeKey('execute', call, n) ?? '')) return true;
    }
    return false;
  }

  async check(toolName: string, kind: PermissionKind, call: ToolCall): Promise<'allow' | 'deny' | 'ask'> {
    if (this.remembered.has(this.rememberKey(toolName, kind, call))) return 'allow';
    if (kind === 'execute' && this.scopeHit(call)) return 'allow';
    if (this.autoAllows(kind)) return 'allow';
    return 'ask';
  }

  async decide(toolName: string, kind: PermissionKind, call: ToolCall): Promise<'allow' | 'deny'> {
    const result = await this.decideDetailed(toolName, kind, call);
    return result === 'allow' ? 'allow' : 'deny';
  }

  /**
   * decide() with the user-typed deny reason preserved end to end (组件7):
   * the host folds it into the hook verdict so the model sees the actual
   * instruction, not a bare "Permission denied: by user".
   */
  async decideDetailed(toolName: string, kind: PermissionKind, call: ToolCall): Promise<DecideResult> {
    const verdict = await this.check(toolName, kind, call);
    if (verdict !== 'ask') return verdict === 'allow' ? 'allow' : { decision: 'deny' };

    const result = await this.enqueueAsk(call, kind);
    const answer: AskAnswer = typeof result === 'string' ? result : result.answer;
    if (answer === 'always') {
      const scoped = typeof result === 'object' && result.answer === 'always' ? result.scopeWords : 1;
      this.remembered.add(this.scopeKey(kind, call, scoped) ?? this.rememberKey(toolName, kind, call));
    }
    this.audit?.({ toolName, kind, outcome: answer });
    if (answer !== 'deny') return 'allow';
    return typeof result === 'object' && result.answer === 'deny' ? { decision: 'deny', reason: result.reason } : { decision: 'deny' };
  }

  /**
   * One serialized ask: queued behind every prior ask (each with its own
   * captured call/kind), immune to a previous asker's failure. 'never'
   * short-circuits; a throwing asker or an invalid answer denies.
   */
  private enqueueAsk(call: ToolCall, kind: PermissionKind): Promise<AskResult> {
    const dispatch = (): AskResult | Promise<AskResult> => {
      if (this.policyCell.policy === 'never') return 'deny';
      return this.ask(call, kind).then(normalizeAsk).catch(() => 'deny' as AskResult);
    };
    const run = this.askChain.then(dispatch, dispatch);
    this.askChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
