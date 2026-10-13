/**
 * The session log's SHAPE, checked at the read boundary.
 *
 * Split from `session-projection.ts` (which owns what a stream MEANS) because
 * this is a different job with a different failure mode: `JSON.parse` guarantees
 * SYNTAX, not SHAPE, and a line that is valid JSON but the wrong shape used to
 * travel through an `as SessionEvent` cast and poison every projection
 * downstream — `deriveMessages` pushing `undefined` into the model surface.
 *
 * No I/O and no state: the reader decides what to do with a rejected line (it
 * takes the same "skip and warn" path as a syntactically broken one).
 */
import type { SessionEvent, SessionHeader } from '../session.js';
import type { AgentMessage } from '../types.js';

/** Structural check for one parsed log line (see `parseEventLine`). */
export function validateEvent(value: unknown): SessionEvent | undefined {
  if (!isObject(value)) return undefined;
  switch (value['type']) {
    case 'message':
      return isAgentMessage(value['message']) ? (value as SessionEvent) : undefined;
    case 'compaction/start':
      return (value['trigger'] === 'auto' || value['trigger'] === 'manual') && isNumber(value['at'])
        ? (value as SessionEvent)
        : undefined;
    case 'compaction/summary':
      return typeof value['summary'] === 'string' && isIndexList(value['keep']) && isNumber(value['at'])
        ? (value as SessionEvent)
        : undefined;
    case 'compaction/end':
    case 'goal/change':
      return isNumber(value['at']) ? (value as SessionEvent) : undefined;
    case 'todo/write':
      return Array.isArray(value['todos']) && isNumber(value['at']) ? (value as SessionEvent) : undefined;
    case 'approval':
    case 'code-dispatch':
      return typeof value['toolName'] === 'string' && isNumber(value['at']) ? (value as SessionEvent) : undefined;
    case 'workspace':
      return typeof value['path'] === 'string' && isNumber(value['at']) ? (value as SessionEvent) : undefined;
    case 'run/stats':
      return isObject(value['stats']) && isNumber(value['at']) ? (value as SessionEvent) : undefined;
    default:
      return undefined;
  }
}

/**
 * Structural check for a session header.
 *
 * A header missing `v`/`id`/`createdAt` is not a session file. Without this
 * check it read as `v: undefined`, which is NOT >= SESSION_VERSION — so the file
 * took the v1 upgrade path and the damage was written back as fact.
 */
export function validateHeader(value: unknown): SessionHeader | undefined {
  if (!isObject(value)) return undefined;
  if (value['type'] !== 'session') return undefined;
  if (!isNumber(value['v']) || typeof value['id'] !== 'string' || !isNumber(value['createdAt'])) return undefined;
  return value as unknown as SessionHeader;
}

/** The bare-message shape v1 logs carry (and the `message` event wraps). */
export function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isObject(value)) return false;
  return typeof value['id'] === 'string' && typeof value['role'] === 'string' && typeof value['content'] === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIndexList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNumber);
}
