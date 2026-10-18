/**
 * A named tool for the loop tests.
 *
 * The loop tests need *some* tool to dispatch, and they script its call by name
 * through the provider — so the name has to match on both sides. This is a local
 * fixture, not a shipped tool: core no longer carries the `get_time` demo, and
 * the tests that used it as a stand-in now own their own definition rather than
 * importing one from `src/`.
 */
import type { ToolDefinition } from '../../src/index.js';

/** Returns a fixed timestamp. The value is never asserted — only the round trip is. */
export const getTimeTool: ToolDefinition = {
  name: 'get_time',
  description: 'Returns a fixed timestamp. Test fixture.',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string' } },
    additionalProperties: false,
  },
  execute: () => '2024-01-01T00:00:00.000Z (UTC)',
  isConcurrencySafe: () => true,
};
