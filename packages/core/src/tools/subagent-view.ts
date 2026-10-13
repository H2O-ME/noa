/**
 * The `subagent` tool's presentation declaration, kept beside the tool rather
 * than inside `createSubagentTool` so the tool's execution body stays readable
 * and this copy can be tested on its own.
 */
import type { ToolCallView, ToolResultView } from '../presentation.js';
/** The brief's opening line, for a call row with no explicit `label`. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * What the delegation IS, before it runs.
 *
 * The operand is the short `label` when one was given, else the brief's opening
 * line: a reader scanning the process group sees WHAT was delegated instead of a
 * bare "工具调用", and the full brief stays one disclosure away.
 * @param args - the call's parsed arguments (untrusted model output).
 * @returns the call view (the `subagents` kind — see `BUILTIN_TOOL_KINDS`).
 */
export function presentSubagentCall(args: Record<string, unknown>): ToolCallView {
  const label = typeof args['label'] === 'string' ? args['label'].trim() : '';
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'].trim() : '';
  const title = label.length > 0 ? label : firstLine(prompt);
  return {
    card: 'generic',
    kind: 'subagents',
    title: title.length > 0 ? title : 'subagent',
    ...(args['run_in_background'] === true ? { subtitle: '后台' } : {}),
  };
}

/**
 * What a delegation returned.
 *
 * The report IS the deliverable: the surface decides how much of it to show
 * (the reference labels this body 代理回复). The `Error:` prefix is the one
 * failure signal the tool itself produces before any nested run starts.
 * @param _args - the call's arguments (unused; the report is self-describing).
 * @param content - the tool result text.
 * @returns the result view.
 */
export function presentSubagentResult(_args: Record<string, unknown>, content: string): ToolResultView {
  return { card: 'generic', ok: !content.startsWith('Error:'), text: content };
}
