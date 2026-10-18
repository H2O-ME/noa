/**
 * 中途插话（`AgentSession.interject`）：一条在轮次跑着的时候到达的消息，应当**并进
 * 那一轮**——不是另起一轮，也不是把那一轮打断。
 *
 * 这套机制真正承重的只有两件事，所以断言也只围着它们：
 *
 *  1. 消息在**下一次请求**里就位。内核的 `messages` 是共享引用，所以「推进去」本身
 *     就是投递；这里断言的是它真的出现在那一轮的第二次装配里。
 *  2. 它带着标记。位置本身有歧义（一串工具结果后面跟一条 user 消息，最自然的读法是
 *     「上一轮结束了」），标记把歧义消掉。
 *
 * 夹具刻意让工具**在它执行的时候**触发插话：那是真实的时刻——用户就是在 agent 干活的
 * 时候打字的，而不是在两个装配之间某个方便的位置。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  ApprovalBroker,
  INTERJECTION_CLOSE,
  INTERJECTION_OPEN,
  JobRegistry,
  QuestionBroker,
  Session,
  formatInterjection,
  interjectionText,
  type AgentHooks,
  type AgentMessage,
  type ChatRequest,
  type KernelEvent,
  type StreamEvent,
  type ToolDefinition,
} from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

/** One tool-call turn, then a plain answer: the run has a "middle" to interject into. */
const WORK_THEN_ANSWER: StreamEvent[][] = [
  [{ type: 'tool_call_delta', index: 0, id: 'call_1', name: 'work', argsDelta: '{}' }],
  [{ type: 'text_delta', text: '答完了' }, { type: 'finish', finishReason: 'stop' }],
];

interface MidRun {
  agent: AgentSession;
  messages: AgentMessage[];
  requests: ChatRequest[];
  events: KernelEvent[];
}

/**
 * A harness whose `work` tool calls back into the test while it executes.
 *
 * That callback is the whole point of the fixture: it is the only place that is
 * reliably INSIDE a live run (between two assemblies) without racing the loop.
 * `hooks` is the other injection point — `beforeTurnEnd` fires at the moment a
 * run is about to end, which is where the "too late to be read" case lives.
 */
async function midRunHarness(
  scripts: StreamEvent[][] = WORK_THEN_ANSWER,
  onWork?: (agent: AgentSession) => void,
  hooks?: AgentHooks,
  extraTools: ToolDefinition[] = [],
): Promise<MidRun> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-interject-'));
  const session = await Session.create(dir, 'sess_interject');
  const messages: AgentMessage[] = [];
  const jobs = new JobRegistry();
  const broker = new ApprovalBroker(() => ({ card: 'generic', kind: 'execute', title: 'work' }));
  const questions = new QuestionBroker();
  const requests: ChatRequest[] = [];
  let agent: AgentSession;
  const work: ToolDefinition = {
    name: 'work',
    description: 'does work',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      onWork?.(agent);
      return 'worked';
    },
  };
  agent = new AgentSession({
    session,
    messages,
    provider: scriptedProvider(scripts, requests),
    rootDir: () => tmpdir(),
    tools: () => [work, ...extraTools],
    hooks: () => hooks,
    jobs,
    approvals: broker,
    questions,
    maxTurns: 6,
    cacheDir: () => tmpdir(),
  });
  const events: KernelEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return { agent, messages, requests, events };
}

async function untilIdle(agent: AgentSession): Promise<void> {
  for (let i = 0; i < 3000 && (agent.running || agent.compacting); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(agent.running).toBe(false);
}

/** The user-role contents of one assembled request. */
function userContents(request: ChatRequest): string[] {
  return request.messages.filter((m) => m.role === 'user').map((m) => m.content);
}

describe('a message typed while the agent is working', () => {
  it('reaches the running turn instead of waiting for it to finish', async () => {
    let accepted: boolean | undefined;
    const h = await midRunHarness(WORK_THEN_ANSWER, (agent) => {
      accepted = agent.interject('顺便看看 8080 端口');
    });

    await h.agent.prompt('先干正事');
    await untilIdle(h.agent);

    // 插话被接受（有在跑的那一轮），而不是被拒。
    expect(accepted).toBe(true);
    // 关键断言：第二次装配——也就是工具跑完之后那一次请求——里已经有这句话了。
    // 如果插话走的是「排队等这一轮结束」，这里会看不到它。
    expect(h.requests.length).toBeGreaterThanOrEqual(2);
    const second = userContents(h.requests[1]!);
    expect(second.some((c) => c.includes('顺便看看 8080 端口'))).toBe(true);
    // 而且只有一轮：插话被那一轮读走了，不该再触发第二次运行、把同一句话答两遍。
    expect(h.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('wraps it in the marker, and only for the model', async () => {
    const h = await midRunHarness(WORK_THEN_ANSWER, (agent) => {
      agent.interject('换个方向');
    });

    await h.agent.prompt('先干正事');
    await untilIdle(h.agent);

    const carried = userContents(h.requests[1]!).find((c) => c.includes('换个方向'));
    expect(carried).toBeDefined();
    expect(carried!.startsWith(INTERJECTION_OPEN)).toBe(true);
    expect(carried!.endsWith(INTERJECTION_CLOSE)).toBe(true);
    // 标记是**持久日志**的一部分，不是只在这一次请求里出现的临时投影：重启后重放
    // 历史必须看到当时模型看到的同一份东西。
    const logged = h.messages.find((m) => m.role === 'user' && m.content.includes('换个方向'));
    expect(logged?.content).toBe(formatInterjection('换个方向'));
    // 而给人看的是原话。
    expect(interjectionText(logged!.content)).toBe('换个方向');
    // 队列泳道也是给人看的，所以它拿到的必须是原话。
    const queued = h.events.filter((e) => e.type === 'queue_update').at(-1);
    expect(queued === undefined || queued.type !== 'queue_update' || queued.items.every((i) => !i.includes(INTERJECTION_OPEN))).toBe(true);
  });

  it('never lands between the tool results of one batch', async () => {
    // 一条 user 消息夹在一批 tool 结果中间，OpenAI 兼容端点是**硬拒**的：
    // `400 Unexpected role 'tool' after role 'user'`（tool 消息必须紧跟在请求它的
    // assistant 消息后面）。而 `runToolCalls` 是一条条 push 结果的，中间有挂起点，
    // 所以「到了就 push」必然能把一批结果劈开——实测就是这个 400。插话因此寄存到
    // 批次之外，由装配前的那一次落位统一推进去。
    //
    // 这里的第二次调用 `second` 就是那个时刻：第一个结果已经在数组里，第二个还没。
    const TWO_CALLS: StreamEvent[][] = [
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'work', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 1, id: 'call_2', name: 'second', argsDelta: '{}' },
      ],
      [{ type: 'text_delta', text: '答完了' }, { type: 'finish', finishReason: 'stop' }],
    ];
    let agent!: AgentSession;
    const second: ToolDefinition = {
      name: 'second',
      description: 'the second call of the batch',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        agent.interject('趁第二个工具在跑');
        return 'seconded';
      },
    };
    const h = await midRunHarness(TWO_CALLS, undefined, undefined, [second]);
    agent = h.agent;

    await h.agent.prompt('先干正事');
    await untilIdle(h.agent);

    // 不变式：任何一次请求里，第一条与最后一条 tool 消息之间不能再有别的角色。
    for (const request of h.requests) {
      const roles = request.messages.map((m) => m.role);
      const first = roles.indexOf('tool');
      const last = roles.lastIndexOf('tool');
      if (first < 0) continue;
      expect(roles.slice(first, last + 1).every((r) => r === 'tool')).toBe(true);
    }
    // 而它并没有被丢掉：落位在整批结果之后，且仍在这一次请求里。
    const carried = h.requests[1]!;
    const roles = carried.messages.map((m) => m.role);
    const spoken = carried.messages.findIndex((m) => m.content.includes('趁第二个工具在跑'));
    expect(spoken).toBeGreaterThan(roles.lastIndexOf('tool'));
    expect(spoken).toBeGreaterThan(-1);
  });

  it('refuses when nothing is running, so the caller can queue it normally', async () => {
    const h = await midRunHarness();
    // 没有在跑的轮次：插话没有落点，如实说不成立（调用方于是走队列、自己开一轮）。
    expect(h.agent.interject('没人在跑')).toBe(false);
    expect(h.messages).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it('refuses after the session is disposed', async () => {
    const h = await midRunHarness();
    await h.agent.dispose();
    expect(h.agent.interject('关门之后')).toBe(false);
  });

  it('still gets its own run when the turn ends before reading it', async () => {
    // 一轮已经答完、循环正要退出时插进来的话，不能消失：它得自己开一轮。`beforeTurnEnd`
    // 是这件事唯一确定的发生点——它就在「模型没有调用工具、这一轮即将结束」的那一刻，
    // 而且仍在 run 之内（`running` 还是 true，所以插话成立）。
    let accepted: boolean | undefined;
    let fired = false;
    const h = await midRunHarness(
      [
        [{ type: 'text_delta', text: '第一轮答完' }, { type: 'finish', finishReason: 'stop' }],
        [{ type: 'text_delta', text: '第二轮答完' }, { type: 'finish', finishReason: 'stop' }],
      ],
      undefined,
      {
        // 只插一次：`turn` 是**每个 run 内部**的计数，每个新 run 都从 1 开始，所以不加
        // 这个闸的话每次收尾都会再插一句、再开一轮，永远停不下来。
        beforeTurnEnd: () => {
          if (!fired) {
            fired = true;
            accepted = h.agent.interject('晚了一步的一句');
          }
          return undefined;
        },
      },
    );

    await h.agent.prompt('第一句');
    await untilIdle(h.agent);

    expect(accepted).toBe(true);
    // 第一轮读不到它（它是在那一轮的最后才进来的），所以必须自己开第二轮。
    expect(h.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    // 而且它一定出现在模型读到的某一次请求里。不可接受的是：进了日志，却从没进过任何
    // 一次请求——那正是「插话消失了」的样子。
    expect(h.requests.some((r) => userContents(r).some((c) => c.includes('晚了一步的一句')))).toBe(true);
  });
});

describe('interjectionText', () => {
  it('returns ordinary text untouched', () => {
    expect(interjectionText('就是一句普通话')).toBe('就是一句普通话');
  });

  it('refuses a half-marker rather than mangling it', () => {
    // 只有开标记（模型自己写出来的、或者被截断的）不该被当成插话剥掉。
    expect(interjectionText(`${INTERJECTION_OPEN}\n半截`)).toBe(`${INTERJECTION_OPEN}\n半截`);
  });
});
