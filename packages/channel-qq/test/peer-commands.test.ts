/**
 * The QQ command surface: which door an inbound line goes through.
 *
 * Two live defects are pinned here.
 *
 *  1. A group message arrives as `<@!bot_openid> /help` — the platform puts the
 *     robot's own mention INTO `content` — so the line began with `<`, no parser
 *     recognized it, and the command was sent to the model as prose. That is why
 *     slash commands worked in DMs and not in groups.
 *  2. `/compact`, `/goal` and every third-party command were not in this
 *     package's private whitelist, so they too became prompts. The kernel's live
 *     catalog decides now.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentSession, ApprovalMode, KernelEvent, SessionService } from '@noa/core';
import { BindingsStore } from '../src/bindings.js';
import { PeerTurns, type RemoteCommandSeat } from '../src/peers.js';
import { parseRemoteCommand, remoteBypassesQueue } from '../src/remote-parse.js';
import { parseInbound, stripLeadingMention } from '../src/types.js';

const PEER = { kind: 'c2c' as const, openid: 'U1', peerId: 'c2c:U1' };

/** Fails loudly if the prompt path is entered, which is how routing is asserted. */
function noSessions(): SessionService {
  return {
    current: () => undefined,
    get: () => undefined,
    list: () => [],
    open: () => Promise.reject(new Error('reached the prompt path')),
    activate: () => undefined,
  };
}

function seat(names: readonly string[]): RemoteCommandSeat & { calls: { name: string; args: string }[] } {
  const calls: { name: string; args: string }[] = [];
  return {
    calls,
    catalog: () => names.map((name) => ({ name, description: `${name} desc` })),
    run: async (name, args) => {
      calls.push({ name, args });
      return { found: true, text: `ran ${name} ${args}`.trim() };
    },
  };
}

async function turnsWith(commands: RemoteCommandSeat): Promise<PeerTurns> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-qqbot-cmd-'));
  return new PeerTurns({
    sessions: noSessions(),
    sessionDir: dir,
    // An empty catalog dir: these tests drive the LIVE-handle path, and a temp
    // root keeps the machine's real sessions out of the listing.
    catalogDir: dir,
    // A real store, in a temp home: the binding is what makes a chat's
    // conversation durable, so a test that stubbed it would not be exercising the
    // path it claims to.
    bindings: new BindingsStore(path.join(dir, 'bindings.json')),
    rootDir: () => 'D:/work',
    model: () => 'm1',
    commands,
    notify: () => undefined,
  });
}

describe('the robot mention prefix', () => {
  it('is stripped once, where the platform is decoded', () => {
    const inbound = parseInbound('GROUP_AT_MESSAGE_CREATE', {
      id: 'IN1',
      group_openid: 'G1',
      author: { member_openid: 'M1' },
      content: '<@!BOT> /compact',
    });
    // Downstream (command parsing, the model prompt) sees the operator's
    // sentence. Without the strip, `content[0]` is `<` and nothing parses it.
    expect(parseRemoteCommand(inbound!.message.content.trim()).text).toBe('/compact');
    // Only LEADING markers: a mention mid-sentence is the operator's own text.
    expect(stripLeadingMention('让 <@!1> 看看')).toBe('让 <@!1> 看看');
  });

  it('treats a non-object payload as no message at all', () => {
    // `null` is valid JSON, so `d: null` used to throw a TypeError out of a
    // socket listener — taking the process down rather than the frame.
    expect(parseInbound('GROUP_AT_MESSAGE_CREATE', null)).toBeUndefined();
    expect(parseInbound('C2C_MESSAGE_CREATE', 42)).toBeUndefined();
  });
});

describe('slashes the kernel owns', () => {
  it('runs a live catalog command with its verbatim argument', async () => {
    const commands = seat(['goal']);
    const turns = await turnsWith(commands);
    expect(await turns.run({ text: '/goal 修好登录' }, PEER)).toEqual({ text: 'ran goal 修好登录' });
    expect(commands.calls).toEqual([{ name: 'goal', args: '修好登录' }]);
  });

  it('follows the catalog, not a name list', async () => {
    // Not in the catalog ⇒ a PROMPT: never swallowed, and never answered with a
    // fabricated "unknown command".
    const turns = await turnsWith(seat([]));
    await expect(turns.run({ text: '/compact' }, PEER)).rejects.toThrow('reached the prompt path');
  });

  it('checks a QQ verb before the catalog', () => {
    // Structural, so it needs no session: a name this package owns is dispatched
    // before the catalog is consulted, because its verbs carry kernel seats a
    // catalog command cannot express (approving an outstanding ask).
    expect(parseRemoteCommand('/status').command).toEqual({ kind: 'status' });
    expect(parseRemoteCommand('/compact').command).toBeUndefined();
  });
});

describe('which commands may skip the serial queue', () => {
  it('bypasses reads and the unblocking answers, tier change included', () => {
    // The bypass exists for ONE deadlock: a turn parked on an approval can only
    // be released by an answer — and `/perm` is the OTHER way out of the same
    // park (stop being asked at all), so it rides with the answers. A new
    // session or a catalog command that mutates state still waits.
    const bypass = (text: string): boolean => {
      const parsed = parseRemoteCommand(text);
      return parsed.command !== undefined && remoteBypassesQueue(parsed.command);
    };
    expect([bypass('/approve'), bypass('/status'), bypass('/help'), bypass('/perm full')]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([bypass('/new'), bypass('/compact')]).toEqual([false, false]);
  });
});

/** One user message, shaped the way the relay listing reads it. */
function userMessage(content: string): AgentMessage {
  return { id: 'm_user', ts: 0, role: 'user', content };
}

/**
 * A minimal session stand-in.
 *
 * `messages` / `session.events` are here because the relay listing reads them (a
 * chooser row is built from the session's own workspace marker and its opening
 * prompt).
 */
function fakeAgent(id: string, mode: ApprovalMode, messages: AgentMessage[] = []): AgentSession {
  const agent = {
    session: { id, file: `${id}.jsonl`, events: [], allMessages: () => [] },
    messages,
    approvalMode: mode as ApprovalMode | undefined,
    disposed: false,
    running: false,
    pendingApprovals: () => [],
    pendingQuestions: () => [],
    resolveApproval: () => true,
    resolveQuestion: () => true,
    abort: () => undefined,
  };
  (agent as unknown as { setApprovalMode: (m: ApprovalMode) => void }).setApprovalMode = (m) => {
    agent.approvalMode = m;
  };
  return agent as unknown as AgentSession;
}

function turnsWithSessions(opts: {
  list: () => AgentSession[];
  open: () => AgentSession;
}): Promise<PeerTurns> {
  return mkdtemp(path.join(tmpdir(), 'nova-qqbot-tier-')).then((dir) =>
    new PeerTurns({
      sessions: {
        current: () => undefined,
        get: () => undefined,
        list: opts.list,
        open: async () => opts.open(),
        activate: () => undefined,
      },
      sessionDir: dir,
      catalogDir: dir,
      bindings: new BindingsStore(path.join(dir, 'bindings.json')),
      rootDir: () => 'D:/work',
      model: () => 'm1',
      notify: () => undefined,
    }),
  );
}

describe('the session listing and relay', () => {
  it('lists conversations by what they are about, with handles that differ', async () => {
    // The listing used to print `sess_c · agent` and `sess_1 · agent`: handles
    // differing by ONE character (the `sess_` prefix ate five of the six) over a
    // directory that was the same on every row. Nothing in that row said which
    // conversation was which, so the one verb this channel exists for was unusable
    // in practice — the reader could not pick the desktop's conversation out.
    const desktop = fakeAgent('sess_a1b2c3d4e5f6', 'full', [userMessage('重构 qqbot 通道')]);
    const other = fakeAgent('sess_9f8e7d6c5b4a', 'full', [userMessage('今天天气怎么样')]);
    const turns = await turnsWithSessions({
      list: () => [desktop, other],
      open: () => fakeAgent('sess_111122223333', 'full'),
    });
    const reply = (await turns.run({ text: '/sessions' }, PEER)).text;
    // The handle is the entropy after the prefix, not the constant prefix itself.
    expect(reply).toContain('a1b2c3');
    expect(reply).toContain('9f8e7d');
    expect(reply).not.toContain('sess_');
    // And the row says what the conversation is about.
    expect(reply).toContain('重构 qqbot 通道');
    expect(reply).toContain('今天天气怎么样');
  });

  it('does not touch the tier of a RELAYED desktop session', async () => {
    // A real conversation: a session nobody has said anything in is not offered
    // as a relay target, so a fixture without a prompt would test the refusal
    // instead of the relay rule.
    const desktop = fakeAgent('desktop-1', 'full', [userMessage('桌面上的那段对话')]);
    const turns = await turnsWithSessions({
      list: () => [desktop],
      open: () => fakeAgent('own-1', 'full'),
    });
    const reply = (await turns.run({ text: `/use ${desktop.session.id.slice(0, 6)}` }, PEER)).text;
    expect(reply).toContain('接到');
    // The phone pointed at the desktop; it did not hand it a new tier.
    expect(desktop.approvalMode).toBe('full');
  });
});

/** A session whose prompt emits one assistant message then goes idle. */
function scriptedAgent(id: string, replyText: string): AgentSession {
  const listeners = new Set<(event: KernelEvent) => void>();
  const agent = {
    ...fakeAgent(id, 'auto'),
    subscribe: (listener: (event: KernelEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: async () => {
      for (const listener of listeners) {
        listener({ type: 'message', message: { id: 'm1', ts: 0, role: 'assistant', content: replyText } } as KernelEvent);
        listener({ type: 'phase', phase: 'idle' } as KernelEvent);
      }
    },
  };
  return agent as unknown as AgentSession;
}

describe('the answer is delivered on the reply budget', () => {
  it('returns the turn\'s answer instead of relaying it as narration', async () => {
    // The caller delivers the return value through the channel's reply seat, which
    // spends the reply class (the reserve narration leaves). Relaying it here as
    // narration put the answer on the DROPPABLE budget.
    const turns = await turnsWithSessions({ list: () => [], open: () => scriptedAgent('s1', '结论正文') });
    expect(await turns.run({ text: '你好' }, PEER)).toEqual({ text: '结论正文', rich: { markdown: '结论正文' } });
  });
});

describe('/retry', () => {
  it('re-runs the dropped turn through the prompt door, not through the command doors', async () => {
    // `/retry` describes the cut and what to say again; the RUN has to go through
    // the same door as any other prompt, or a retried turn could behave
    // differently from the turn it replaces.
    const rewound: number[] = [];
    const prompted: string[] = [];
    const listeners = new Set<(event: KernelEvent) => void>();
    const agent = {
      ...fakeAgent('retry-1', 'auto'),
      subscribe: (listener: (event: KernelEvent) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      rewindTurns: async (turns: number) => {
        rewound.push(turns);
        return { keepIds: [], dropped: 1, prompt: { id: 'u1', ts: 0, role: 'user', content: '重发这句' } };
      },
      prompt: async (text: string) => {
        prompted.push(text);
        for (const listener of listeners) {
          listener({ type: 'message', message: { id: 'm9', ts: 0, role: 'assistant', content: `答复：${text}` } } as KernelEvent);
          listener({ type: 'phase', phase: 'idle' } as KernelEvent);
        }
      },
    } as unknown as AgentSession;
    const turns = await turnsWithSessions({ list: () => [], open: () => agent });

    const answer = await turns.run({ text: '/retry' }, PEER);
    expect(rewound).toEqual([1]);
    expect(prompted).toEqual(['重发这句']);
    // ONE outbound message: the answer replaces the acknowledgement, so the reply
    // reserve is not spent on saying "on it".
    expect(answer).toEqual({ text: '答复：重发这句', rich: { markdown: '答复：重发这句' } });
  });

  it('answers with the kernel\'s refusal when the cut cannot happen', async () => {
    const agent = {
      ...fakeAgent('retry-2', 'auto'),
      rewindTurns: async () => undefined,
    } as unknown as AgentSession;
    const turns = await turnsWithSessions({ list: () => [], open: () => agent });
    expect((await turns.run({ text: '/retry' }, PEER)).text).toContain('没有可以重做的轮次');
  });
});
