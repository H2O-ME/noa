/**
 * Folding a session log into its context reading — the one walk that answers
 * "what is in the window, how did it grow, why did it change, what did it do".
 *
 * Ported in shape from the dsh-context plugin's timeline fold (MIT,
 * bowenliang123/dsh-context): one pass over the durable event stream, an
 * ELEMENT list (one row per tool schema, fragment section and message, stamped
 * with the log position it entered at) plus a POINT list (one per completed
 * model request). A point's composition is the elements that had entered before
 * it — so one element list explains every past request, and the wire stays
 * proportional to the session rather than to its requests.
 *
 * Nova-specific, and deliberately NOT a port of dsh's metering: prices come
 * from `core`'s own `estimateTextTokens` / `estimateMessageTokens`, the same
 * heuristic the auto-compact gate already pays with, so the panel and the gate
 * cannot disagree about what a message costs. Provider-reported usage rides
 * alongside untouched — an estimate is never dressed up as a bill.
 *
 * The fold is STATEFUL and mutating on purpose: it accumulates over an
 * append-only stream, one event at a time, for as long as a session lives, so
 * handing back a fresh object per event would copy every list on every tool
 * result for no reader's benefit.
 */
import {
  compactionSurface,
  contextSections,
  emptyBreakdown,
  estimateMessageTokens,
  estimateTextTokens,
  isContextFragment,
  type AgentMessage,
  type AssistantMessage,
  type ContextBreakdown,
  type ContextElement,
  type ContextEventRecord,
  type ContextFold,
  type ContextPoint,
  type ContextSurface,
  type ContextTimeline,
  type ContextWindowSnapshot,
  type FileOpRecord,
  type SessionEvent,
  type ToolResultMessage,
} from '@noa/core';
import { fileOpOfCall, type FileOp } from './file-ops.js';

/**
 * Bounds. A reading is a window, not an archive: past these the oldest rows are
 * dropped and the timeline says so, rather than growing a frame without limit.
 * Elements go last and only once they are OFF the surface — a dropped `gone`
 * row costs a historical explanation, while a dropped live row would make the
 * composition a lie.
 */
const MAX_ELEMENTS = 600;
const MAX_POINTS = 400;
const MAX_EVENTS = 200;
const MAX_FILES = 300;

/** Characters kept of any label or preview. Long enough to recognize, short enough to ship. */
const PREVIEW = 160;
const LABEL = 60;

/** A tool result that reports failure. Both spellings the tools actually emit. */
function failed(content: string): boolean {
  return content.startsWith('Error:') || content.startsWith('Permission denied');
}

/** One line, trailing whitespace gone, cut to `max` characters. */
function preview(text: string, max = PREVIEW): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Token price of one tool schema as the provider receives it. */
function toolTokens(tool: { name: string; description?: string; parameters?: unknown }): number {
  // The wire shape is `{type:'function',function:{name,description,parameters}}`
  // (see the ai client's serializer). The wrapper's own few tokens are not
  // reproduced: the estimate is a composition reading, and a schema's size is
  // its body.
  const parameters = tool.parameters === undefined ? '{}' : JSON.stringify(tool.parameters);
  return estimateTextTokens(`${tool.name}\n${tool.description ?? ''}\n${parameters}`);
}

/** What the surface looked like, for spotting a change without keeping the text. */
function surfacePrint(surface: ContextSurface): string {
  const tools = (surface.tools ?? []).map((tool) => `${tool.name}:${toolTokens(tool)}`).join('|');
  return `${surface.system?.length ?? 0}\u0000${tools}`;
}

/** The fold's state and the one walk that advances it. */
class ContextReading implements ContextFold {
  private readonly elements: ContextElement[] = [];
  /** Message id behind each element (`elements[i]`), for compaction resolution. */
  private readonly origin: (string | undefined)[] = [];
  /** Every message the log has carried, in order — what a compaction resolves `keep` against. */
  private readonly messages: AgentMessage[] = [];
  private readonly points: ContextPoint[] = [];
  /** Assistant message id → index into `points`, so a `run/stats` event can find its point. */
  private readonly pointByMessageId = new Map<string, number>();
  /** Point seq → the assistant message id that produced it (for truncation rebuilds). */
  private readonly pointMessageIds = new Map<number, string>();
  private readonly events: ContextEventRecord[] = [];
  private readonly files = new Map<string, FileOpRecord>();
  /** Tool calls awaiting their result, so an op is recorded only if it RAN. */
  private readonly pending = new Map<string, { op: FileOp; seq: number }>();
  private seq = 0;
  private turns = 0;
  private toolCalls = 0;
  private compactions = 0;
  private truncated = false;
  private lastSurface: ContextSurface | undefined;
  private print: string | undefined;

  constructor(events: readonly SessionEvent[], surface?: ContextSurface) {
    for (const event of events) this.apply(event, surface);
  }

  apply(event: SessionEvent, surface?: ContextSurface): void {
    const seq = this.seq;
    this.seq += 1;
    this.syncSurface(seq, surface);
    switch (event.type) {
      case 'message':
        this.applyMessage(seq, event.message);
        break;
      case 'compaction/summary':
        this.applyCompaction(seq, event);
        break;
      case 'compaction/end':
        // The summary already accounted for the swap; a failure here is why it
        // did not happen, and it is the one thing a reader would otherwise see
        // as "the window shrank for no reason".
        if (event.error !== undefined) {
          this.pushEvent({ seq, at: event.at, kind: 'compaction', detail: preview(event.error, LABEL) });
        }
        break;
      case 'workspace':
        this.pushEvent({ seq, at: event.at, kind: 'workspace', detail: event.path });
        break;
      case 'goal/change':
        this.pushEvent({
          seq,
          at: event.at,
          kind: 'goal',
          ...(event.goal !== null ? { detail: preview(event.goal.objective, LABEL) } : {}),
        });
        break;
      case 'run/stats':
        // The run's measurements — log-only bookkeeping, but the per-request
        // timings are joined onto the matching `ContextPoint` so a Timing card
        // can draw a per-request TTFT/response-duration series. The event
        // anchors itself with the LAST assistant message id of the run; its
        // timing entry is the LAST one in `requestTimings` (the others belong
        // to earlier iterations whose own `run/stats` would have carried them
        // — but a single run that spanned multiple iterations reports them all
        // here, in order, so we distribute them across the run's points).
        this.applyRunStats(event);
        break;
      // Every remaining variant is log-only bookkeeping that does not move the
      // window: an approval audit, a plan snapshot, a PTC dispatch, the
      // compaction lock itself.
      default:
        break;
    }
  }

  view(): ContextTimeline {
    const live: ContextElement[] = [];
    const cats = emptyBreakdown();
    let total = 0;
    for (const element of this.elements) {
      if (element.gone !== undefined) continue;
      live.push(element);
      cats[element.cat] += element.tokens;
      total += element.tokens;
    }
    return {
      truncated: this.truncated,
      live: { cats, total, elements: live },
      counts: {
        requests: this.points.length,
        turns: this.turns,
        toolCalls: this.toolCalls,
        compactions: this.compactions,
      },
      points: [...this.points],
      events: [...this.events],
      files: [...this.files.values()].sort((a, b) => b.seq - a.seq),
    };
  }

  /**
   * Frozen window snapshot at one position — the Browser/DNA cards' read. Same
   * composition rule as `compositionBefore(seq)`: an element is in the window
   * iff it entered before `seq` AND had not been removed by a compaction whose
   * own position is `<= seq`. The point at `seq` (if any) is attached so the
   * Browser card can head the panel with the request's own usage.
   *
   * Returns `undefined` when nothing entered before `seq` — that is a seq past
   * the run's first element, not a legitimate "empty window" (a request that
   * saw only its own surface has at least the surface rows).
   */
  windowAt(seq: number): ContextWindowSnapshot | undefined {
    const elements: ContextElement[] = [];
    const cats = emptyBreakdown();
    let total = 0;
    for (const element of this.elements) {
      if (element.seq >= seq) break;
      if (element.gone !== undefined && element.gone <= seq) continue;
      elements.push(element);
      cats[element.cat] += element.tokens;
      total += element.tokens;
    }
    if (elements.length === 0 && total === 0) {
      // Distinguish "no element entered before seq" (a missing position) from
      // "the window had elements but all were zero-token rows" — the latter
      // keeps its (zero-total) snapshot, the former is undefined.
      const hadAny = this.elements.some((e) => e.seq < seq);
      if (!hadAny) return undefined;
    }
    const point = this.points.find((p) => p.seq === seq);
    return { seq, elements, cats, total, ...(point !== undefined ? { point } : {}) };
  }

  // ── the surface ───────────────────────────────────────────────────────────

  /**
   * Re-price the system prompt and the tool schemas when they change.
   *
   * Stamped `seq - 1` on purpose: the surface in force for a request always
   * entered BEFORE that request's own message, so one rule (`element.seq <
   * point.seq`) keeps a point's composition exact without special cases — and
   * the row for a schema the request itself carried is not excluded from it.
   *
   * Identity is checked before the content print because callers hold stable
   * references (`PluginHost.tools` is deliberately the same array between
   * rebuilds), so the common case costs one comparison.
   */
  private syncSurface(seq: number, surface: ContextSurface | undefined): void {
    if (surface === undefined || surface === this.lastSurface) return;
    const print = surfacePrint(surface);
    this.lastSurface = surface;
    if (print === this.print) return;
    this.print = print;
    const at = seq - 1;
    for (const element of this.elements) {
      if ((element.cat === 'system' || element.cat === 'tools') && element.gone === undefined) {
        element.gone = at;
      }
    }
    const system = surface.system;
    if (system !== undefined && system.length > 0) {
      this.push({ seq: at, cat: 'system', label: 'system', tokens: estimateTextTokens(system), preview: preview(system) }, undefined);
    }
    for (const tool of surface.tools ?? []) {
      this.push({ seq: at, cat: 'tools', label: tool.name, tokens: toolTokens(tool) }, undefined);
    }
  }

  // ── messages ──────────────────────────────────────────────────────────────

  private applyMessage(seq: number, msg: AgentMessage): void {
    this.messages.push(msg);
    if (isContextFragment(msg)) {
      // One row per section, each naming its PRODUCER (the environment block,
      // the operator's directives, the AGENTS.md chain, the skills index) —
      // the split core already owns, so the panel and the transcript's context
      // rows cannot disagree about what was injected.
      const sections = contextSections(msg);
      if (sections.length === 0) {
        this.push(
          { seq, cat: 'injected', label: 'context', tokens: estimateMessageTokens(msg), preview: preview(msg.content) },
          msg.id,
        );
        return;
      }
      for (const section of sections) {
        this.push(
          {
            seq,
            cat: 'injected',
            label: section.tag,
            tokens: estimateTextTokens(section.text),
            preview: preview(section.text),
          },
          // Every section of one fragment belongs to that message: a compaction
          // keeps or drops the fragment as a whole.
          msg.id,
        );
      }
      return;
    }
    switch (msg.role) {
      case 'user':
        this.turns += 1;
        this.push(
          {
            seq,
            cat: 'user',
            label: preview(msg.content, LABEL) || '（空消息）',
            tokens: estimateMessageTokens(msg),
            preview: preview(msg.content),
          },
          msg.id,
        );
        break;
      case 'assistant':
        this.push(
          {
            seq,
            cat: 'assistant',
            label: this.assistantLabel(msg),
            tokens: estimateMessageTokens(msg),
            preview: preview(msg.content),
          },
          msg.id,
        );
        for (const call of msg.toolCalls ?? []) {
          this.toolCalls += 1;
          const op = fileOpOfCall(call);
          // Recorded when the RESULT lands, not here: a call that was denied or
          // failed did not touch the file, and a row saying it did is the one
          // lie this card could tell.
          if (op !== undefined) this.pending.set(call.id, { op, seq });
        }
        this.pushPoint(seq, msg);
        break;
      case 'tool':
        this.applyToolResult(seq, msg);
        break;
      case 'system':
        // Not written to a Nova log today (the prompt is prefix-frozen outside
        // it); kept so a log that does carry one is still priced.
        this.push({ seq, cat: 'system', label: 'system', tokens: estimateMessageTokens(msg) }, msg.id);
        break;
      default:
        break;
    }
  }

  private assistantLabel(msg: AssistantMessage): string {
    const said = preview(msg.content, LABEL);
    if (said.length > 0) return said;
    const calls = msg.toolCalls ?? [];
    if (calls.length === 0) return '（空回复）';
    return calls.length === 1 ? `调用 ${calls[0]!.name}` : `调用 ${calls.length} 个工具`;
  }

  private applyToolResult(seq: number, msg: ToolResultMessage): void {
    this.push(
      {
        seq,
        cat: 'tool',
        label: msg.name,
        tokens: estimateMessageTokens(msg),
        preview: preview(msg.content),
        ok: !failed(msg.content),
      },
      msg.id,
    );
    const waiting = this.pending.get(msg.toolCallId);
    if (waiting === undefined) return;
    this.pending.delete(msg.toolCallId);
    if (failed(msg.content)) return;
    this.record(waiting.seq, waiting.op);
  }

  // ── points, events, files ─────────────────────────────────────────────────

  /**
   * One completed model request. The composition is read BEFORE this message's
   * own element counts (elements are appended in `seq` order, and the assistant
   * row was stamped with this same `seq`).
   */
  private pushPoint(seq: number, msg: AssistantMessage): void {
    const cats = this.compositionBefore(seq);
    let total = 0;
    for (const category of Object.keys(cats) as (keyof ContextBreakdown)[]) total += cats[category];
    const usage = msg.usage;
    const point: ContextPoint = {
      seq,
      at: msg.ts,
      cats,
      total,
      ...(usage !== undefined
        ? { prompt: usage.promptTokens, cached: usage.cachedTokens, output: usage.completionTokens }
        : {}),
    };
    this.points.push(point);
    this.pointByMessageId.set(msg.id, this.points.length - 1);
    if (this.points.length > MAX_POINTS) {
      this.truncated = true;
      const drop = this.points.length - MAX_POINTS;
      this.points.splice(0, drop);
      // Indices shift by `drop`; rebuild the message-id → index map. Points
      // whose message was among the dropped ones simply stop resolving — a
      // late `run/stats` for an evicted point finds no entry, which is right.
      this.pointByMessageId.clear();
      for (let i = 0; i < this.points.length; i += 1) {
        const id = this.pointMessageIds.get(this.points[i]!.seq);
        if (id !== undefined) this.pointByMessageId.set(id, i);
      }
    }
    // Remember which message produced this seq, for the rebuild above.
    this.pointMessageIds.set(seq, msg.id);
  }

  private compositionBefore(seq: number): ContextBreakdown {
    const cats = emptyBreakdown();
    for (const element of this.elements) {
      if (element.seq >= seq) break;
      if (element.gone !== undefined && element.gone <= seq) continue;
      cats[element.cat] += element.tokens;
    }
    return cats;
  }

  /**
   * Join a `run/stats` event's per-request timings onto the points the run
   * produced. Each entry in `stats.requestTimings` corresponds to one loop
   * iteration in the run, in order; each iteration produces exactly one
   * assistant message and therefore one point. The event's `afterMessageId`
   * names the run's LAST assistant message — so the timings map to a SUFFIX
   * of the run's points (same count, same order).
   *
   * A run whose `requestTimings` is absent (old logs that predate the field)
   * contributes nothing — those points keep no `timing` and a Timing card
   * hides itself.
   */
  private applyRunStats(event: Extract<SessionEvent, { type: 'run/stats' }>): void {
    const timings = event.stats.requestTimings;
    if (timings === undefined || timings.length === 0) return;
    const anchorId = event.afterMessageId;
    if (anchorId === undefined) return;
    const anchorIdx = this.pointByMessageId.get(anchorId);
    if (anchorIdx === undefined) return;
    // The anchor is the LAST point of the run; the run produced
    // `timings.length` points, so earlier timings map to the (anchor - i - 1)
    // points before it. Defensive against a timings array that exceeds the
    // points available (a partial log replay): cap at the points we have.
    const runPoints = Math.min(timings.length, anchorIdx + 1);
    for (let i = 0; i < runPoints; i += 1) {
      const pointIdx = anchorIdx - runPoints + 1 + i;
      const point = this.points[pointIdx];
      if (point === undefined) continue;
      const timing = timings[i]!;
      // Don't overwrite a timing already joined (a duplicate event from a
      // re-emit): first writer wins, which keeps the earliest record.
      if (point.timing !== undefined) continue;
      point.timing = {
        startedAt: timing.startedAt,
        ...(timing.firstTokenAt !== undefined ? { firstTokenAt: timing.firstTokenAt } : {}),
        ...(timing.finishedAt !== undefined ? { finishedAt: timing.finishedAt } : {}),
      };
    }
  }

  /**
   * A compaction replaced the surface: everything the kept set does not name
   * goes off the window, and the summary takes its place.
   *
   * The kept set is resolved by `core`'s own `compactionSurface` — the SAME
   * function the live compaction path and the replay projection use — so a
   * panel reading the fold and a transcript reading the log can never disagree
   * about what survived.
   */
  private applyCompaction(seq: number, event: Extract<SessionEvent, { type: 'compaction/summary' }>): void {
    const after = compactionSurface(event, this.messages, seq);
    const kept = new Set(after.map((msg) => msg.id));
    for (let i = 0; i < this.elements.length; i++) {
      const element = this.elements[i]!;
      if (element.gone !== undefined) continue;
      const from = this.origin[i];
      if (from !== undefined && !kept.has(from)) element.gone = seq;
    }
    const summary = after[after.length - 1];
    if (summary !== undefined) {
      this.push(
        {
          seq,
          cat: 'injected',
          label: 'compaction',
          tokens: estimateTextTokens(summary.content),
          preview: preview(event.summary),
        },
        summary.id,
      );
    }
    this.compactions += 1;
    this.pushEvent({ seq, at: event.at, kind: 'compaction', freed: event.shadowedTokenCount });
    this.trim();
  }

  private pushEvent(record: ContextEventRecord): void {
    this.events.push(record);
    if (this.events.length > MAX_EVENTS) {
      this.truncated = true;
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  private record(seq: number, op: FileOp): void {
    const existing = this.files.get(op.path);
    if (existing === undefined) {
      this.files.set(op.path, {
        path: op.path,
        reads: op.kind === 'read' ? 1 : 0,
        writes: op.kind === 'write' ? 1 : 0,
        searches: op.kind === 'search' ? 1 : 0,
        added: op.added ?? 0,
        removed: op.removed ?? 0,
        seq,
      });
      if (this.files.size > MAX_FILES) {
        this.truncated = true;
        // Oldest first: the row a reader still cares about is the recent one.
        let oldest: string | undefined;
        let at = Number.POSITIVE_INFINITY;
        for (const [path, row] of this.files) {
          if (row.seq < at) {
            at = row.seq;
            oldest = path;
          }
        }
        if (oldest !== undefined) this.files.delete(oldest);
      }
      return;
    }
    // A new object, not a mutation: the view hands these rows to a caller that
    // may still be holding the previous reading.
    this.files.set(op.path, {
      ...existing,
      reads: existing.reads + (op.kind === 'read' ? 1 : 0),
      writes: existing.writes + (op.kind === 'write' ? 1 : 0),
      searches: existing.searches + (op.kind === 'search' ? 1 : 0),
      added: existing.added + (op.added ?? 0),
      removed: existing.removed + (op.removed ?? 0),
      seq,
    });
  }

  /** Append one element with its origin. */
  private push(element: ContextElement, origin: string | undefined): void {
    this.elements.push(element);
    this.origin.push(origin);
  }

  /**
   * Drop history once the element list is over its bound — removed rows first
   * (a past point's composition is already baked into the point), then the
   * oldest live rows, which is the point at which the reading says it is
   * incomplete rather than quietly reporting a smaller window.
   */
  private trim(): void {
    if (this.elements.length <= MAX_ELEMENTS) return;
    this.truncated = true;
    let over = this.elements.length - MAX_ELEMENTS;
    // Removed rows first, oldest forward (they are the ones a point no longer
    // needs), then the oldest live rows as a last resort.
    for (let i = 0; i < this.elements.length && over > 0; ) {
      if (this.elements[i]!.gone !== undefined) {
        this.elements.splice(i, 1);
        this.origin.splice(i, 1);
        over -= 1;
      } else {
        i += 1;
      }
    }
    while (this.elements.length > MAX_ELEMENTS) {
      this.elements.shift();
      this.origin.shift();
    }
  }
}

/** The context-insight capability: open a fold over a session log. */
export function contextInsightsOf(): {
  fold(events: readonly SessionEvent[], surface?: ContextSurface): ContextFold;
  windowAt(events: readonly SessionEvent[], seq: number, surface?: ContextSurface): ContextWindowSnapshot | undefined;
} {
  return {
    fold: (events, surface) => new ContextReading(events, surface),
    windowAt: (events, seq, surface) => windowAtSeq(events, seq, surface),
  };
}

/**
 * Read the window snapshot at one request's log position — the Browser/DNA
 * cards' data source. Walks the events once with the same fold the live path
 * uses, so the snapshot's composition CANNOT disagree with the trend's view of
 * what a past request was made of.
 *
 * Returns `undefined` when no element entered before `seq` (a seq that points
 * past the end, or one before the first element): an empty window is a real
 * answer (the request saw only its own surface, not nothing), but a missing
 * position is not — the Browser card distinguishes the two by whether the host
 * answered at all.
 */
export function windowAtSeq(
  events: readonly SessionEvent[],
  seq: number,
  surface?: ContextSurface,
): ContextWindowSnapshot | undefined {
  const reading = new ContextReading(events, surface);
  return reading.windowAt(seq);
}
