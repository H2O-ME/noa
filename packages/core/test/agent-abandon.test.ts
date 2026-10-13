import { describe, expect, it } from 'vitest';
import { NOT_EXECUTED_GUIDANCE, runAgent, type AgentEvent, type AgentMessage, type JobNotice, type StreamEvent } from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

/**
 * 弃用路径（M8.3-9 前在 core 测试中零命中）：消费者中途 break/throw 会让
 * for-await 对生成器调 .return()，finally 里的两个契约——未消费 job 通知回队、
 * 未应答 tool_calls 合成 NOT_EXECUTED_GUIDANCE 结果——没有任何 in-band 错误
 * 处理路径覆盖，只能这样直接钉住。
 */

const TOOL_CALL_SCRIPT: StreamEvent[] = [
  { type: 'tool_call_delta', index: 0, id: 'c1', name: 'bash', argsDelta: '{"command":"echo hi"}' },
  { type: 'finish', finishReason: 'tool_calls' },
];

function fakeJobs(drain: JobNotice[] = [{ id: 'bash-1', kind: 'bash', sessionId: '', label: 'echo hi', status: 'completed' }]): {
  jobs: { drainFinished(): JobNotice[]; requeue(items: JobNotice[]): void };
  requeued: JobNotice[][];
} {
  const requeued: JobNotice[][] = [];
  return {
    jobs: {
      drainFinished: () => drain,
      requeue: (items) => requeued.push(items),
    },
    requeued,
  };
}

async function take(gen: AsyncGenerator<AgentEvent>, n: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for (let i = 0; i < n; i++) {
    const next = await gen.next();
    if (next.done) break;
    events.push(next.value);
  }
  return events;
}

describe('runAgent abandonment (consumer breaks early)', () => {
  it('synthesizes NOT_EXECUTED_GUIDANCE results for unanswered tool_calls on .return()', async () => {
    const { jobs } = fakeJobs();
    const messages: AgentMessage[] = [];
    const gen = runAgent({
      provider: scriptedProvider([TOOL_CALL_SCRIPT]),
      messages,
      rootDir: '.',
      ...(jobs !== undefined ? { jobs: jobs as never } : {}),
    });
    // 消费到 message 事件（assistant 已带 tool_calls 推入 surface）后弃用。
    await take(gen, 2); // turn_start, message
    await gen.return(undefined);

    const toolResults = messages.filter((m): m is Extract<AgentMessage, { role: 'tool' }> => m.role === 'tool');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolCallId).toBe('c1');
    expect(toolResults[0]!.content).toContain(NOT_EXECUTED_GUIDANCE);
  });

  it('requeues drained-but-unannounced job notices when abandoned mid-stream', async () => {
    const { jobs, requeued } = fakeJobs();
    const messages: AgentMessage[] = [];
    const gen = runAgent({
      provider: scriptedProvider([
        [
          { type: 'text_delta', text: 'partial' },
          { type: 'finish', finishReason: 'stop' },
        ],
      ]),
      messages,
      rootDir: '.',
      ...(jobs !== undefined ? { jobs: jobs as never } : {}),
    });
    // 消费 turn_start + text_delta（通知已 drain、回复未提交），随即弃用。
    // drain 发生在 turn_start 之后的 assembleRequest 里，比第一个流事件更早
    // 挂起——所以取 2 个事件才能越过提交点之前的簿记。
    await take(gen, 2);
    await gen.return(undefined);

    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toEqual([{ id: 'bash-1', kind: 'bash', sessionId: '', label: 'echo hi', status: 'completed' }]);
  });

  it('does not requeue when the assistant reply committed before abandonment', async () => {
    const { jobs, requeued } = fakeJobs();
    const messages: AgentMessage[] = [];
    const gen = runAgent({
      provider: scriptedProvider([TOOL_CALL_SCRIPT]),
      messages,
      rootDir: '.',
      ...(jobs !== undefined ? { jobs: jobs as never } : {}),
    });
    await take(gen, 2); // turn_start, message（提交点：notices.consumed = true）
    await gen.return(undefined);
    expect(requeued).toEqual([]);
  });
});
