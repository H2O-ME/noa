import type { ToolDefinition } from '../types.js';

/** M1 demo tool used to verify the tool-call round trip; real tools land in M2. */
export const getTimeTool: ToolDefinition = {
  name: 'get_time',
  description:
    'Returns the current date and time. Use when the user asks about the current time or date.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone, e.g. "Asia/Shanghai". Defaults to local time.',
      },
    },
    additionalProperties: false,
  },
  execute(args) {
    const now = new Date();
    const tz = typeof args['timezone'] === 'string' ? args['timezone'] : undefined;
    if (tz) {
      try {
        const formatted = new Intl.DateTimeFormat('zh-CN', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now);
        return `${formatted} (${tz})`;
      } catch {
        return `Error: unknown timezone "${tz}"; current local time is ${now.toISOString()}`;
      }
    }
    return now.toISOString();
  },
  isConcurrencySafe() {
    return true;
  },
};
