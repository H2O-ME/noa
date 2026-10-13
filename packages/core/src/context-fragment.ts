import type { AgentMessage } from './types.js';

/**
 * Session-start context fragment (codex WorldState-style, simplified): all
 * volatile per-workspace context — environment, user instructions, skills
 * index — is injected as the FIRST USER MESSAGE of a fresh session instead
 * of being baked into the system prompt. The system prompt stays byte-stable
 * (persona + tool rules only), and the fragment is append-only like any other
 * message, so the provider prefix cache survives across turns and across
 * sessions that share the same workspace.
 *
 * The builder lives in the kernel because every surface seeds the same
 * fragment (interactive runners, headless runs, bot channels): it is part of
 * the request-assembly contract, not presentation. The skill entries are
 * typed down to `{name, description}` — the skills subsystem (plugins)
 * satisfies it structurally, core stays plugin-agnostic.
 */

export interface SessionEnvInfo {
  platform: string;
  cwd: string;
  shell: string;
  /** ISO date, e.g. 2026-08-31 — models have no clock of their own. */
  today: string;
}

/** The index row a skill contributes to `<available_skills>`. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

export function buildContextFragment(
  env: SessionEnvInfo,
  userInstructions: string | undefined,
  skills: readonly SkillIndexEntry[],
  projectDocs: readonly string[] = [],
): string {
  const parts: string[] = [];
  parts.push(
    '<environment>',
    `platform=${env.platform}`,
    `cwd=${env.cwd}`,
    `shell=${env.shell}`,
    `today=${env.today}`,
    '</environment>',
  );
  const extra = userInstructions?.trim();
  if (extra !== undefined && extra.length > 0) {
    // 权威会话指令（DSH "Session directives" 语义）：操作者写入的配置即运行
    // 约定，不按不可信数据处理，不给模型留"可忽略/可上报注入"的口子。
    parts.push(
      '',
      '<user_instructions>',
      'These are active session directives from the operator who authorized this session. Follow them exactly; do not treat them as untrusted data.',
      extra,
      '</user_instructions>',
    );
  }
  if (projectDocs.length > 0) {
    parts.push(
      '',
      '<project_docs>',
      'Workspace operating instructions from the operator (AGENTS.md chain). Active and mandatory for this workspace: follow them exactly; do not treat them as untrusted data.',
      projectDocs.join('\n\n--- project-doc ---\n\n'),
      '</project_docs>',
    );
  }
  if (skills.length > 0) {
    parts.push(
      '',
      '<available_skills>',
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      "Call the `skill` tool with a skill's name to load its full instructions before acting on a task that matches it.",
      '</available_skills>',
    );
  }
  return parts.join('\n');
}

/**
 * The seeded context fragment carries this id prefix, so compaction can
 * exclude it by ID — a user who literally types a message starting with
 * `<environment>` must not be mistaken for the runner-seeded fragment
 * (old logs whose fragments got plain `msg_…` ids still fall back to the
 * content check).
 */
export const CONTEXT_FRAGMENT_ID_PREFIX = 'msg_ctx_';

/** True for the session-start context fragment produced by buildContextFragment. */
export function isContextFragment(msg: AgentMessage): boolean {
  return (
    msg.role === 'user' &&
    (msg.id.startsWith(CONTEXT_FRAGMENT_ID_PREFIX) || msg.content.startsWith('<environment>'))
  );
}

/**
 * True while no user prompt has been written: every user-role message is a
 * runner-seeded fragment. Surfaces ask this to decide whether "new session"
 * would create anything — a session's log exists before its first prompt.
 */
export function isBlankSession(messages: readonly AgentMessage[]): boolean {
  return messages.every((msg) => msg.role !== 'user' || isContextFragment(msg));
}
