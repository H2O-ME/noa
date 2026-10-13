/**
 * The nested-dispatch seam (ctx.dispatch) used by PTC mode's run_code:
 * sub-calls must go through the same gate as native calls while never
 * touching the message log.
 */
import { describe, expect, it } from 'vitest';
import {
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type StreamEvent,
  type ToolDefinition,
  type ToolDispatchCall,
  type ToolDispatchResult,
} from '../src/index.js';
import { scriptedProvider, collect } from './helpers/scripted-provider.js';

/** The parent tool: forwards its nested dispatch outcome verbatim as the result. */
function parentTool(childName: string, extra?: (call: ToolDispatchCall) => Promise<ToolDispatchResult>): ToolDefinition {
  return {
    name: 'parent',
    description: 'dispatches a sub-call',
    parameters: { type: 'object' },
    async execute(args, ctx) {
      const result =
        extra !== undefined ? await extra({ name: childName, args: (args['sub'] as Record<string, unknown>) ?? {} }) : await ctx.dispatch?.({ name: childName, args: {} });
      return JSON.stringify(result ?? { ok: false, error: 'no dispatch' });
    },
  };
}

const childTool: ToolDefinition = {
  name: 'child',
  description: 'a sub-callable tool',
  parameters: { type: 'object' },
  execute: () => 'child-result',
};

const PARENT_CALL: StreamEvent[] = [
  { type: 'tool_call_delta', index: 0, id: 'call_p', name: 'parent', argsDelta: '{}' },
  { type: 'finish', finishReason: 'tool_calls' },
];
const FINAL: StreamEvent[] = [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }];

function parentResult(events: AgentEvent[]): string {
  const result = events.find(
    (ev): ev is Extract<AgentEvent, { type: 'tool_call_result' }> => ev.type === 'tool_call_result',
  );
  return result?.result.content ?? '';
}

describe('ctx.dispatch (nested tool calls)', () => {
  it('runs the sub-call through the pipeline and keeps it out of the message log', async () => {
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider: scriptedProvider([PARENT_CALL, FINAL]), messages, rootDir: '.', tools: [parentTool('child'), childTool] }),
    );
    expect(JSON.parse(parentResult(events))).toEqual({ ok: true, result: 'child-result' });
    // parent + child ran; only the parent's result message is logged
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('honors beforeToolCall denial for sub-calls (ok:false, reason passed back)', async () => {
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({
        provider: scriptedProvider([PARENT_CALL, FINAL]),
        messages,
        rootDir: '.',
        tools: [parentTool('child'), childTool],
        hooks: {
          beforeToolCall: async (call) => (call.name === 'child' ? { action: 'deny', reason: 'gate says no' } : { action: 'allow' }),
        },
      }),
    );
    const outcome = JSON.parse(parentResult(events)) as { ok: boolean; error?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('gate says no');
  });

  it('applies afterToolResult to sub-call results too', async () => {
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({
        provider: scriptedProvider([PARENT_CALL, FINAL]),
        messages,
        rootDir: '.',
        tools: [parentTool('child'), childTool],
        hooks: { afterToolResult: async (call, result) => (call.name === 'child' ? `${result}!` : result) },
      }),
    );
    expect(JSON.parse(parentResult(events))).toEqual({ ok: true, result: 'child-result!' });
  });

  it('reports unknown tools and pre-aborted runs as refusals', async () => {
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider: scriptedProvider([PARENT_CALL, FINAL]), messages, rootDir: '.', tools: [parentTool('nope')] }),
    );
    expect(parentResult(events)).toContain('unknown tool');

    const controller = new AbortController();
    controller.abort('stopped');
    const abortedMessages: AgentMessage[] = [];
    const abortedEvents = await collect(
      runAgent({
        provider: scriptedProvider([[{ type: 'tool_call_delta', index: 0, id: 'call_p', name: 'parent', argsDelta: '{}' }, { type: 'finish', finishReason: 'tool_calls' }]]),
        messages: abortedMessages,
        rootDir: '.',
        tools: [parentTool('child'), childTool],
        signal: controller.signal,
      }),
    );
    // the pre-aborted run ends as aborted before any tool executes
    expect(abortedEvents.at(-1)?.type).toBe('done');
  });

  it('a pre-aborted per-call signal refuses the sub-call before executing it', async () => {
    const child: ToolDefinition = {
      ...childTool,
      execute: async () => {
        throw new Error('child must not execute after its run signal was already aborted');
      },
    };
    const parent: ToolDefinition = {
      ...parentTool('child'),
      execute: async (_args, ctx) => {
        const controller = new AbortController();
        controller.abort('sub-run over');
        const outcome = await ctx.dispatch?.({ name: 'child', args: {} }, controller.signal);
        return JSON.stringify(outcome ?? { ok: false, error: 'no dispatch' });
      },
    };
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider: scriptedProvider([PARENT_CALL, FINAL]), messages, rootDir: '.', tools: [parent, child] }),
    );
    const outcome = JSON.parse(parentResult(events)) as { ok: boolean; error?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('run is over');
  });
});
