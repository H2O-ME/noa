/**
 * The `/goal` command: the reader's door to the durable goal.
 *
 * The command owns only the SYNTAX a reader types. Every state transition goes
 * through core's goal domain (`createGoal` / `editGoal` / `pauseGoal` /
 * `resumeGoal`), so a command cannot reach a state the tools could not, and
 * every write goes through the session's single door (`announceGoal`), which
 * records the durable `goal/change` before it publishes the live event.
 *
 * Grammar and the state-dependent command list are ported from the reference's
 * `goal/command-goal`: `<objective>` creates, `edit <objective>` replaces,
 * `pause` / `resume` / `clear` are exact control words, and blank shows the goal
 * in force. The reference's compare-and-set revision is absent here (this kernel
 * has one writer per mutation path), so nothing in the output names it.
 *
 * Kept out of `kernel-commands.ts` because it answers a different question: that
 * file owns the catalog and the runner, this one owns the goal's human grammar.
 */
import {
  createGoal,
  editGoal,
  pauseGoal,
  resumeGoal,
  type AgentSession,
  type CommandDefinition,
  type Goal,
  type GoalStatus,
} from '@noa/core';

/** The status word a reader sees — user-facing, therefore Chinese. */
const STATUS_LABEL: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
};

/** The usage line, repeated wherever a request cannot be served. */
const USAGE = '用法：/goal [<目标>|clear|edit <目标>|pause|resume]';

/** One parsed `/goal` invocation. */
export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'create'; objective: string }
  | { kind: 'edit'; objective: string }
  | { kind: 'invalid-edit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' };

/**
 * Parse only the grammar `/goal` owns; every other input is an objective, so
 * `/goal 修好登录` needs no quoting while the control words stay exact.
 * @param raw - the argument text as typed.
 * @returns the invocation to run.
 */
export function parseGoalCommand(raw: string): GoalCommand {
  const input = raw.trim();
  if (input === '') return { kind: 'show' };
  const control = input.toLowerCase();
  if (control === 'clear') return { kind: 'clear' };
  if (control === 'pause') return { kind: 'pause' };
  if (control === 'resume') return { kind: 'resume' };
  if (control === 'edit') return { kind: 'invalid-edit' };
  if (/^edit\s/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() };
  return { kind: 'create', objective: input };
}

/**
 * The commands worth trying from the goal's current state — the reference prints
 * this list after the goal's own fields, so a reader never has to guess which
 * control words this state accepts.
 * @param goal - the goal in force.
 * @returns the list, as one line.
 */
export function availableGoalCommands(goal: Goal): string {
  const edit = '/goal edit <目标>';
  if (goal.status === 'active') return `${edit}, /goal pause, /goal clear`;
  if (goal.status === 'complete') return `/goal <目标>, /goal clear`;
  return `${edit}, /goal resume, /goal clear`;
}

/**
 * One goal, as the command prints it.
 * @param title - what just happened to it.
 * @param goal - the stored value.
 * @returns the multi-line report.
 */
export function renderGoal(title: string, goal: Goal): string {
  return [
    `${title} — ${STATUS_LABEL[goal.status]}`,
    `编号：${goal.id}`,
    `目的：${goal.objective}`,
    `轮次：${String(goal.rounds)}/${String(goal.maxRounds)}`,
    ...(goal.blockedReason !== undefined ? [`受阻：${goal.blockedReason}`] : []),
    `可用：${availableGoalCommands(goal)}`,
  ].join('\n');
}

/** The refusal for a control word that needs a goal to act on. */
function missingGoal(action: string): string {
  return `当前没有目标，/goal ${action} 需要先有目标。\n${USAGE}`;
}

/**
 * Run one parsed invocation against the session in force.
 * @param command - the parsed invocation.
 * @param agent - the session the command writes to.
 * @param log - the command's own output line writer.
 */
async function execute(
  command: GoalCommand,
  agent: AgentSession,
  log: (message: string) => void,
): Promise<void> {
  const current = agent.session.latestGoal();
  switch (command.kind) {
    case 'show':
      log(current === undefined ? `当前没有目标。\n${USAGE}` : renderGoal('目标', current));
      return;
    case 'invalid-edit':
      log(`改目标需要给出新的目标：/goal edit <目标>。\n${USAGE}`);
      return;
    case 'create': {
      if (current !== undefined && current.status !== 'complete') {
        log(`已有目标（${STATUS_LABEL[current.status]}）。用 /goal edit <目标> 修改，或先 /goal clear。`);
        return;
      }
      const created = createGoal(command.objective);
      await agent.announceGoal(created);
      log(renderGoal('已建立目标', created));
      return;
    }
    case 'edit': {
      if (current === undefined) {
        log(missingGoal('edit'));
        return;
      }
      // A completed goal's round counter describes work that is over, so an
      // objective REPLACES it rather than reviving a spent budget — the rule
      // `update_goal` follows too.
      const next = current.status === 'complete'
        ? createGoal(command.objective, { maxRounds: current.maxRounds })
        : editGoal(current, command.objective);
      await agent.announceGoal(next);
      log(renderGoal('已修改目标', next));
      return;
    }
    case 'pause':
    case 'resume': {
      if (current === undefined) {
        log(missingGoal(command.kind));
        return;
      }
      // `complete` is terminal: pausing or resuming it would make the status a
      // lie, and the domain refuses to resume one for exactly that reason.
      if (current.status === 'complete') {
        log('目标已完成。要重新开始请建立新目标：/goal <目标>。');
        return;
      }
      const next = command.kind === 'pause' ? pauseGoal(current) : resumeGoal(current);
      await agent.announceGoal(next);
      log(renderGoal(command.kind === 'pause' ? '已暂停目标' : '已恢复目标', next));
      return;
    }
    case 'clear':
      if (current === undefined) {
        log('当前没有目标，无需清除。');
        return;
      }
      await agent.announceGoal(null);
      log('已清除目标。');
      return;
  }
}

/**
 * The `/goal` command, bound to whoever can name the session in force.
 * @param sessionOf - the live session, read at RUN time: a command outlives a
 *   session switch, so a captured handle would write to a closed log.
 * @returns the command definition.
 */
export function goalCommand(sessionOf: () => AgentSession | undefined): CommandDefinition {
  return {
    name: 'goal',
    description: '设定或查看长期目标：/goal <目标>，或 edit <目标> / pause / resume / clear',
    async run(args, out) {
      const agent = sessionOf();
      if (agent === undefined) {
        out.log('没有活动的会话');
        return;
      }
      await execute(parseGoalCommand(args), agent, (message) => { out.log(message); });
    },
  };
}
