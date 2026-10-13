import { tools as toolsKey, type Plugin, type ToolExecuteContext } from '@noa/core';
import { registerTool } from '../toolbox.js';

/**
 * Model-facing control surface for background jobs started via
 * `bash { run_in_background: true }`. Jobs that finish naturally
 * (completed/failed) are announced automatically on the next LLM request
 * via JobRegistry.drainFinished() — the model does NOT need to poll.
 * This tool is for reading incremental output or stopping a job early.
 */
export function jobsPlugin(): Plugin {
  return {
    name: 'jobs',
    description: 'Inspect and control background jobs started with the bash tool.',
    manifest: { title: '后台任务', description: '查看与控制 bash 启动的后台任务。', tier: 'standard' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'jobs',
        description:
          'Lists, reads output of, or stops background jobs. Args: action ("list" | "output" | "stop", required), id (required for output/stop). A background job that finishes is announced to you automatically — do not poll in a loop; when notified, read its output once with action=output.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'output', 'stop'],
              description: 'list all jobs, read new output since the last read, or request termination.',
            },
            id: { type: 'string', description: 'Job id (e.g. "bash-1"); required for output and stop.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        async execute(args, c: ToolExecuteContext) {
          if (c.jobs === undefined) return 'No background jobs available in this context.';
          const action = typeof args['action'] === 'string' ? args['action'] : 'list';
          // Scoped to the calling session: the registry is per-process, so an
          // unscoped read would let one conversation list, read or kill another
          // conversation's work.
          const sessionId = c.sessionId;

          if (action === 'list') {
            const jobs = c.jobs.list(sessionId);
            if (jobs.length === 0) return 'No background jobs.';
            return jobs
              .map((job) => `- ${job.id} [${job.status}] ${job.label}${job.detail !== undefined ? ` (${job.detail})` : ''}`)
              .join('\n');
          }

          const id = typeof args['id'] === 'string' ? args['id'] : '';
          if (id.length === 0) return 'Error: id is required for output and stop actions';

          if (action === 'output') {
            const job = c.jobs.get(id, sessionId);
            if (job === undefined) return `Error: unknown job "${id}"`;
            const output = c.jobs.readOutput(id, undefined, sessionId);
            const lines = [`${job.id} [${job.status}] ${job.label}${job.detail !== undefined ? ` (${job.detail})` : ''}`];
            lines.push(output !== undefined && output.length > 0 ? output : '(no new output since last read)');
            return lines.join('\n');
          }

          // action === 'stop'
          const stopped = await c.jobs.stop(id, 'stopped by model', sessionId);
          if (stopped === undefined) return `Error: unknown job "${id}"`;
          return `Stop requested for ${stopped.id}. Current status: ${stopped.status}.`;
        },
        // Only `list` is a pure read. `output` consumes the job's output cursor
        // (two concurrent reads split the ring buffer and each loses bytes) and
        // `stop` mutates job state, so neither may share a parallel segment.
        isConcurrencySafe(args) {
          return (typeof args['action'] === 'string' ? args['action'] : 'list') === 'list';
        },
      }, 'read');
    },
  };
}
