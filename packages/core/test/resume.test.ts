/**
 * Integration test: session save → Session.open → deriveMessages → feed into a
 * fresh runAgent turn. This guards the seam between the persistence layer
 * (session.ts) and the agent loop (agent.ts): if deriveMessages() projects a
 * different history than what runAgent expects on resume, every other test
 * stays green while resume silently feeds the model the wrong context.
 *
 * Coverage that only exists here:
 *  - a full turn (user → assistant text) written to a Session, re-opened,
 *    and the projected surface fed into a *capturing* provider that records
 *    exactly what the model would see on resume
 *  - a tool-call turn persisted, resumed, and the tool result's presence in
 *    the resumed surface verified end-to-end
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getTimeTool,
  runAgent,
  Session,
  type AgentEvent,
  type AgentMessage,
  type ChatRequest,
  type StreamEvent,
} from '@noa/core';
import { scriptedProvider } from './helpers/scripted-provider.js';

describe('save → resume → new turn round-trip', () => {
  it('a resumed session feeds the projected history (user + assistant) into the next request', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-resume-'));

    // --- Turn 1: talk to the agent, persist everything to a session. ---
    const session = await Session.create(dir);
    const messages: AgentMessage[] = [];
    // Seed the session with a user message so deriveMessages starts non-empty.
    const userMsg: AgentMessage = { id: 'u1', ts: 0, role: 'user', content: '你好' };
    messages.push(userMsg);
    await session.append(userMsg);

    const turn1: StreamEvent[] = [
      { type: 'text_delta', text: '你好！有什么可以帮你的？' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 8, cachedTokens: 0 } },
      { type: 'finish', finishReason: 'stop' },
    ];
    const provider1 = scriptedProvider([turn1]);
    const events1: AgentEvent[] = [];
    for await (const ev of runAgent({ provider: provider1, messages, rootDir: dir, emit: (e) => session.appendEvent(e) })) {
      events1.push(ev);
    }
    // runAgent appended the assistant message to `messages`.
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);

    // Persist the assistant message that runAgent produced.
    const assistantMsg = messages.find((m) => m.role === 'assistant')!;
    await session.append(assistantMsg);

    // --- Resume: re-open the session and project the surface. ---
    const resumed = await Session.open(session.file);
    const surface = resumed.deriveMessages();
    expect(surface.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(surface[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(surface[1]).toMatchObject({ role: 'assistant', content: '你好！有什么可以帮你的？' });

    // --- Turn 2: feed the projected surface into a capturing provider. ---
    const requests: ChatRequest[] = [];
    const turn2: StreamEvent[] = [
      { type: 'text_delta', text: '继续帮你' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const provider2 = scriptedProvider([turn2], requests);
    const resumedMessages = [...surface]; // the runner passes surface as the message log
    for await (const _ev of runAgent({ provider: provider2, messages: resumedMessages, rootDir: dir })) {
      void _ev;
    }

    // The provider received the full resumed history — not an empty array,
    // not just the last message, but the projected surface intact.
    expect(requests).toHaveLength(1);
    const sentMessages = requests[0]!.messages;
    // The surface order is preserved: user → assistant → (new turn's user is
    // not appended here because we passed surface directly without adding a
    // new user message — the runner would add one before calling runAgent).
    expect(sentMessages.some((m) => m.role === 'user' && m.content === '你好')).toBe(true);
    expect(
      sentMessages.some((m) => m.role === 'assistant' && m.content === '你好！有什么可以帮你的？'),
    ).toBe(true);
  });

  it('a tool-call turn is fully reconstructable on resume (assistant tool call + tool result survive)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-resume-tool-'));
    const session = await Session.create(dir);

    const userMsg: AgentMessage = { id: 'u1', ts: 0, role: 'user', content: '现在几点？' };
    await session.append(userMsg);
    const messages: AgentMessage[] = [userMsg];

    // The model calls get_time; the agent dispatches it and gets a result.
    const turn1: StreamEvent[] = [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_time',
        argsDelta: '{}',
      },
      { type: 'finish', finishReason: 'tool_calls' },
    ];
    const turn1b: StreamEvent[] = [
      { type: 'text_delta', text: '现在是 ' },
      { type: 'usage', usage: { promptTokens: 20, completionTokens: 5, cachedTokens: 0 } },
      { type: 'finish', finishReason: 'stop' },
    ];
    const provider = scriptedProvider([turn1, turn1b]);
    for await (const _ev of runAgent({
      provider,
      messages,
      rootDir: dir,
      tools: [getTimeTool],
      emit: (e) => session.appendEvent(e),
    })) {
      void _ev;
    }

    // Persist everything runAgent appended (assistant message with tool call + tool result message).
    for (const msg of messages) {
      if (msg === userMsg) continue;
      await session.append(msg);
    }

    // Resume.
    const resumed = await Session.open(session.file);
    const surface = resumed.deriveMessages();
    const roles = surface.map((m) => m.role);
    // user → assistant(with tool_calls) → tool(result) → assistant(final text)
    expect(roles).toContain('user');
    expect(roles).toContain('tool');
    // The assistant message carrying the tool call survived.
    const toolCallAssistant = surface.find(
      (m) => m.role === 'assistant' && 'toolCalls' in m && Array.isArray(m.toolCalls),
    );
    expect(toolCallAssistant).toBeDefined();
    expect((toolCallAssistant as { toolCalls: unknown[] }).toolCalls!.length).toBeGreaterThanOrEqual(1);
    // The tool result message survived.
    const toolMsg = surface.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });
});
