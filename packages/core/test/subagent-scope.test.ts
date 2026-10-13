/**
 * ExecutionScope threading — the security property behind F01.
 *
 * A nested run (a subagent) used to invoke `runAgent` with a FRESH options
 * object: no sessionId, no runId, no principal. Its tool calls therefore
 * carried an EMPTY `ToolCallScope`, and the approval gate fell back to the
 * kernel engine — an escalation path when the parent conversation was more
 * restricted than the kernel default (parent read-only, kernel full), and
 * mis-attributed asks when it was not. These tests pin the three halves:
 *
 *  - the run scope (sessionId + minted runId + principal) reaches every hook
 *    round of a plain run;
 *  - a nested subagent run INHERITS the parent's sessionId (same conversation,
 *    different runId) instead of going scopeless;
 *  - the nested toolset excludes session-state tools by the declared flag, not
 *    by a hard-coded name list.
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent.js';
import { createSubagentTool } from '../src/tools/subagent.js';
import { nestedToolset } from '../src/tools/nested-run.js';
import { collect, scriptedProvider } from './helpers/scripted-provider.js';
import type { AgentEvent, ToolCallScope, ToolDefinition } from '../src/types.js';

const TOOL_CALL = (id: string, name: string, args: string) => [
  { type: 'tool_call_delta' as const, index: 0, id, name, argsDelta: args },
  { type: 'finish' as const, finishReason: 'tool_calls' },
];
const SAY = (text: string) => [{ type: 'text_delta' as const, text }, { type: 'finish' as const, finishReason: 'stop' }];

function probe(): ToolDefinition {
  return { name: 'probe', description: 'capture scope', parameters: { type: 'object' }, execute: () => 'evidence' };
}

describe('runAgent / scope threading', () => {
  it('threads sessionId, a minted runId, and the principal into every hook round', async () => {
    const scopes: ToolCallScope[] = [];
    const events = await collect(
      runAgent({
        provider: scriptedProvider([TOOL_CALL('c1', 'probe', '{}'), SAY('done')]),
        messages: [],
        rootDir: '.',
        tools: [probe()],
        maxTurns: 2,
        scope: { sessionId: 'sess-1', principal: 'qq:cap:read-only' },
        hooks: {
          beforeToolCall: async (_call, scope) => {
            scopes.push(scope ?? {});
            return { action: 'allow' };
          },
        },
      }),
    );
    expect(events.some((e: AgentEvent) => e.type === 'tool_call_result')).toBe(true);
    expect(scopes.length).toBe(1);
    expect(scopes[0]).toMatchObject({ sessionId: 'sess-1', principal: 'qq:cap:read-only' });
    expect(typeof scopes[0]?.runId).toBe('string');
    expect(scopes[0]?.runId?.length).toBeGreaterThan(0);
  });
});

describe('subagent / nested scope inheritance', () => {
  it('a nested subagent run carries the PARENT session scope with its own runId', async () => {
    const byCall = new Map<string, ToolCallScope>();
    const subagent = createSubagentTool({
      // The NESTED loop's provider: probe for evidence, then report.
      provider: scriptedProvider([TOOL_CALL('n1', 'probe', '{}'), SAY('complete\nall found')]),
      tools: () => [probe()],
      hooks: () => ({
        beforeToolCall: async (call, scope) => {
          byCall.set(call.name, scope ?? {});
          return { action: 'allow' };
        },
      }),
      rootDir: () => '.',
    });
    // The PARENT loop: delegate, then finish after the tool result lands.
    const events = await collect(
      runAgent({
        provider: scriptedProvider([TOOL_CALL('c1', 'subagent', '{"prompt":"find things"}'), SAY('delegated')]),
        messages: [],
        rootDir: '.',
        tools: [subagent],
        maxTurns: 2,
        scope: { sessionId: 'parent-1' },
        hooks: {
          beforeToolCall: async (call, scope) => {
            byCall.set(call.name, scope ?? {});
            return { action: 'allow' };
          },
        },
      }),
    );
    const report = events.find((e): e is Extract<AgentEvent, { type: 'tool_call_result' }> => e.type === 'tool_call_result');
    expect(report?.result.content).toContain('all found');

    // THE property: the nested 'probe' call is scoped to the PARENT session.
    // Revert the inheritance and this goes red — probe's scope comes back
    // empty and the gate falls back to the kernel engine.
    expect(byCall.get('probe')).toMatchObject({ sessionId: 'parent-1' });
    // Two invocations of runAgent = two run identities under the one session.
    expect(byCall.get('probe')?.runId).toBeTruthy();
    expect(byCall.get('probe')?.runId).not.toBe(byCall.get('subagent')?.runId);
    expect(byCall.get('subagent')).toMatchObject({ sessionId: 'parent-1' });
  });

  it('a nested run spills oversized tool output into the PARENT cache dir, not the global fallback', async () => {
    const seen: string[] = [];
    const spillProbe: ToolDefinition = {
      name: 'probe',
      description: 'capture cacheDir',
      parameters: { type: 'object' },
      execute: (_args, ctx) => {
        seen.push(ctx.cacheDir ?? '(global fallback)');
        return 'evidence';
      },
    };
    const subagent = createSubagentTool({
      provider: scriptedProvider([TOOL_CALL('n1', 'probe', '{}'), SAY('complete\nall found')]),
      tools: () => [spillProbe],
      hooks: () => ({ beforeToolCall: async () => ({ action: 'allow' }) }),
      rootDir: () => '.',
    });
    await collect(
      runAgent({
        provider: scriptedProvider([TOOL_CALL('c1', 'subagent', '{"prompt":"find things"}'), SAY('delegated')]),
        messages: [],
        rootDir: '.',
        tools: [subagent],
        maxTurns: 2,
        scope: { sessionId: 'parent-1' },
        cacheDir: '/nova/tool-outputs/parent-1',
        hooks: { beforeToolCall: async () => ({ action: 'allow' }) },
      }),
    );
    // THE property: the nested loop offloads into the parent conversation's
    // cache dir. Revert the threading and probe sees the global fallback —
    // the nested run's spill files land outside the session's cache.
    expect(seen).toEqual(['/nova/tool-outputs/parent-1']);
  });
});

describe('nestedToolset', () => {
  it('drops the subagent itself and every tool that owns session state — by flag', () => {
    const self: ToolDefinition = { name: 'subagent', description: '', parameters: { type: 'object' }, execute: () => '' };
    const todo: ToolDefinition = { name: 'todo_write', description: '', parameters: { type: 'object' }, execute: () => '', ownsSessionState: true };
    const thirdPartyBoard: ToolDefinition = { name: 'my_board', description: '', parameters: { type: 'object' }, execute: () => '', ownsSessionState: true };
    const plain = probe();
    expect(nestedToolset([self, todo, thirdPartyBoard, plain], 'subagent').map((tool) => tool.name)).toEqual(['probe']);
  });

  it('keeps stateless tools untouched', () => {
    const bash: ToolDefinition = { name: 'bash', description: '', parameters: { type: 'object' }, execute: () => '' };
    expect(nestedToolset([bash, probe()], 'subagent')).toHaveLength(2);
  });
});
