import { describe, expect, it } from 'vitest';
import { createSubagentTool } from '../src/tools/subagent.js';
import type { AgentMessage, ChatProvider, StreamEvent, ToolDefinition } from '../src/index.js';

const ANSWER: StreamEvent[] = [
  { type: 'text_delta', text: 'the report' },
  { type: 'finish', finishReason: 'stop' },
];

function noopTool(name: string): ToolDefinition {
  return {
    name,
    description: 'x',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'x',
  };
}

describe('subagent tool', () => {
  it('runs a nested loop on a fresh surface and returns the final report as the tool result', async () => {
    const requests: AgentMessage[][] = [];
    let call = 0;
    const provider: ChatProvider = {
      async *stream(req) {
        requests.push([...req.messages]); // snapshot: runAgent grows the array in place
        const events =
          call === 0
            ? [
                { type: 'tool_call_delta', index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' },
                { type: 'usage', usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0 } },
                { type: 'finish', finishReason: 'tool_calls' },
              ]
            : [
                ...ANSWER,
                { type: 'usage', usage: { promptTokens: 50, completionTokens: 10, cachedTokens: 0 } },
              ];
        call += 1;
        for (const ev of events) yield ev as StreamEvent;
      },
    };
    const readFile = noopTool('read_file');
    const tool = createSubagentTool({ provider, tools: () => [readFile], rootDir: () => '.' });
    const out = await tool.execute({ prompt: 'analyze a.txt', label: 'scan' }, { rootDir: '.' });

    expect(out).toContain('[subagent: scan ·');
    expect(out).toContain('the report');
    // Usage trailer: own-loop consumption travels with the report, never
    // merged into the parent stats (2 nested request rounds, 150+30 tok).
    expect(out).toContain('[subagent: scan · 2 turns · 1 tools · 150+30 tok · ');
    // Two nested provider calls: the first turned tool_calls and the nested
    // read_file executed inside the subagent's own loop.
    expect(requests).toHaveLength(2);
    // Context isolation: the subagent's request surface contains ONLY its own
    // prompt + nested traffic — no parent history.
    expect(requests[0]).toHaveLength(1);
    expect(requests[0]![0]!.content).toContain('analyze a.txt');
  });

  it('filters subagent itself out of the nested toolset (no recursion)', async () => {
    let seenTools: string[] | undefined;
    const provider: ChatProvider = {
      async *stream(req) {
        seenTools = req.tools?.map((t) => t.name);
        for (const ev of ANSWER) yield ev;
      },
    };
    // The parent's live tool list includes the subagent tool itself.
    const parent = createSubagentTool({ provider, tools: () => [], rootDir: () => '.' });
    const tool = createSubagentTool({ provider, tools: () => [parent, noopTool('other')], rootDir: () => '.' });
    await tool.execute({ prompt: 'x' }, { rootDir: '.' });
    expect(seenTools).toEqual(['other']);
  });

  it('injects the scout posture into the nested run (read-only recon, status-first report)', async () => {
    const prompts: (string | undefined)[] = [];
    const provider: ChatProvider = {
      async *stream(req) {
        prompts.push(req.systemPrompt);
        for (const ev of ANSWER) yield ev;
      },
    };
    const tool = createSubagentTool({ provider, tools: () => [], rootDir: () => '.' });
    await tool.execute({ prompt: 'x' }, { rootDir: '.' });
    expect(prompts[0]).toContain('Subagent posture (scout)');
    expect(prompts[0]).toContain('Do NOT design, refactor or implement');
    expect(prompts[0]).toContain('"complete", "partial" or "blocked"');
  });

  it('rejects an empty prompt without touching the provider', async () => {
    let called = 0;
    const provider: ChatProvider = {
      async *stream() {
        called += 1;
        for (const ev of ANSWER) yield ev;
      },
    };
    const tool = createSubagentTool({ provider, tools: () => [], rootDir: () => '.' });
    expect(await tool.execute({ prompt: '  ' }, { rootDir: '.' })).toContain('non-empty');
    expect(called).toBe(0);
  });

  it('forwards nested progress moments to onProgress (start/tool_call/done)', async () => {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'read_file', argsDelta: '{}' };
        yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 0 } };
        yield { type: 'finish', finishReason: 'tool_calls' };
        yield { type: 'text_delta', text: 'nested report' };
        yield { type: 'usage', usage: { promptTokens: 5, completionTokens: 1, cachedTokens: 0 } };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    const seen: string[] = [];
    const tool = createSubagentTool({
      provider,
      tools: () => [noopTool('read_file')],
      rootDir: () => '.',
      onProgress: (p) => {
        if (p.type === 'tool_call') seen.push(`tool:${p.call.name}`);
        else if (p.type === 'usage') seen.push(`usage:${p.stats.promptTokens}`);
        else seen.push(p.type);
      },
    });
    const out = await tool.execute({ prompt: 'x', label: 'vis' }, { rootDir: '.' });
    expect(seen[0]).toBe('start');
    expect(seen).toContain('tool:read_file');
    expect(seen).toContain('usage:15');
    expect(seen.at(-1)).toBe('done');
    expect(out).toContain('nested report');
  });

  it('run_in_background returns a job handle immediately and settles with a usage detail', async () => {
    const provider: ChatProvider = {
      async *stream() {
        for (const ev of ANSWER) yield ev;
      },
    };
    const { JobRegistry } = await import('../src/jobs.js');
    const jobs = new JobRegistry();
    const tool = createSubagentTool({ provider, tools: () => [], rootDir: () => '.' });
    const started = (await tool.execute({ prompt: 'background brief', label: 'bg', run_in_background: true }, { rootDir: '.', jobs })) as string;
    expect(started).toContain('subagent-1');

    // Settle the run: drain the notice (announcement contract) and read the report.
    const notices = jobs.drainFinished();
    expect(notices).toHaveLength(0); // async run hasn't settled yet at this tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done2 = jobs.drainFinished();
    expect(done2).toHaveLength(1);
    expect(done2[0]?.kind).toBe('subagent');
    expect(done2[0]?.detail).toContain('[subagent: bg · ');
    const out = jobs.readOutput('subagent-1');
    expect(out).toContain('the report');
    expect(out).toContain('[subagent: bg · ');
  });

  it('background job snapshot exposes nested progress (tool count + last call) for UI live rows', async () => {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a.ts"}' };
        yield { type: 'finish', finishReason: 'tool_calls' };
        for (const ev of ANSWER) yield ev;
      },
    };
    const { JobRegistry } = await import('../src/jobs.js');
    const jobs = new JobRegistry();
    const tool = createSubagentTool({ provider, tools: () => [noopTool('read_file')], rootDir: () => '.' });
    await tool.execute({ prompt: 'brief', label: 'vis', run_in_background: true }, { rootDir: '.', jobs });
    // let the nested loop reach its first tool call
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = jobs.get('subagent-1');
    // the provider answers every turn with a tool call, so the count runs to
    // maxTurns — assert the SHAPE (count + last call), not an exact number
    expect(snapshot?.progress).toMatch(/^\d+ tools · read_file /);
  });

  it('an EMPTY final assistant message never returns mid-run narration as the report', async () => {
    // Reasoning-style providers can spend the closing turn in reasoning_content
    // and answer with empty content. The nested runAgent now treats an empty
    // completion as a pathology: it retries, then THROWS — so the stale
    // mid-run narration can no longer surface as a "completed" report (old
    // capture returned "Now let me examine…" as the whole delegation report).
    const provider: ChatProvider = {
      async *stream() {
        // turn 1: narration + tool call; every later turn: EMPTY final message
        if (!this.called) {
          this.called = true;
          yield { type: 'text_delta', text: 'Now let me examine the target file structure:' } as StreamEvent;
          yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'read_file', argsDelta: '{"path":"a"}' } as StreamEvent;
          yield { type: 'finish', finishReason: 'tool_calls' } as StreamEvent;
        } else {
          yield { type: 'finish', finishReason: 'stop' } as StreamEvent;
        }
      },
    } as ChatProvider & { called?: boolean };
    const tool = createSubagentTool({ provider, tools: () => [noopTool('read_file')], rootDir: () => '.' });
    await expect(tool.execute({ prompt: 'x', label: 'empty-final' }, { rootDir: '.' })).rejects.toThrow(
      /empty completion 3 times.*reasoning_content/s,
    );
  });
});
