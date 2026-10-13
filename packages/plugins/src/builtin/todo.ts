import { isFailureContent, tools as toolsKey } from '@noa/core';
import type { Plugin, TodoItem, ToolExecuteContext } from '@noa/core';
import { registerTool } from '../toolbox.js';

const STATUSES = ['pending', 'in_progress', 'completed'] as const;

function parseTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return 'Error: todos must be an array of {content, status}';
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return 'Error: each todo must be an object';
    const content = (entry as Record<string, unknown>)['content'];
    const status = (entry as Record<string, unknown>)['status'];
    if (typeof content !== 'string' || content.trim().length === 0) {
      return 'Error: each todo needs a non-empty content string';
    }
    if (typeof status !== 'string' || !STATUSES.includes(status as (typeof STATUSES)[number])) {
      return `Error: todo status must be one of ${STATUSES.join(', ')}`;
    }
    items.push({ content, status: status as TodoItem['status'] });
  }
  return items;
}

/**
 * dsh-style durable todo: the tool replaces the WHOLE list on every write
 * (last-write-wins, deliberately no ids/priorities) and the snapshot is
 * persisted as a log-only session event, so it survives resume via the log
 * without ever joining the model surface.
 */
export function todoPlugin(): Plugin {
  return {
    name: 'todo',
    description: 'Maintain a durable task checklist for the current session.',
    manifest: { title: '任务清单', description: '维护当前会话的任务清单。', tier: 'standard' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'todo_write',
        description:
          'Replaces the whole session todo list. Args: todos (required) — array of { content: string, status: "pending" | "in_progress" | "completed" }. Write the complete list every time; mark exactly one task in_progress while working on it.',
        // The board belongs to THIS conversation: a nested ephemeral run (a
        // subagent) must not write it — without this marker the nested run
        // either polluted the parent's board (emit inherited) or silently
        // pretended success (emit absent). See `nestedToolset`.
        ownsSessionState: true,
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: 'The complete replacement todo list.',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: 'Short imperative task line.' },
                  status: { type: 'string', enum: [...STATUSES] },
                },
                required: ['content', 'status'],
                additionalProperties: false,
              },
            },
          },
          required: ['todos'],
          additionalProperties: false,
        },
        async execute(args, c: ToolExecuteContext) {
          const parsed = parseTodos(args['todos']);
          if (typeof parsed === 'string') return parsed;
          if (c.emit !== undefined) {
            await c.emit({ type: 'todo/write', todos: parsed, at: Date.now() });
          }
          if (parsed.length === 0) return 'Todo list cleared.';
          return parsed
            .map((item) => {
              const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
              return `${mark} ${item.content}`;
            })
            .join('\n');
        },
        presentResult(args, content) {
          const parsed = parseTodos(args['todos']);
          if (typeof parsed === 'string' || isFailureContent(content)) return undefined;
          return {
            card: 'plan',
            items: parsed.map((item) => ({ text: item.content, status: item.status })),
          };
        },
        // Pure log write, no filesystem or process effects.
        isConcurrencySafe() {
          return true;
        },
      }, 'read');
    },
  };
}
