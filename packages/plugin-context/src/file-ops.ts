/**
 * What the run did to the workspace's files, read back out of the tool calls.
 *
 * Split from `fold.ts` because it answers a different question over the same
 * stream: the fold asks "what is in the window", this asks "what did it touch".
 * The two share only the log.
 *
 * The map from tool name to op is a TABLE because it is knowledge about the
 * tool set, not a rule the fold could derive: `read_file` names a file to read
 * and `search_files` names a directory to scan, and nothing in the log says so.
 * An unknown tool (a third-party one, `bash`, a PTC program) contributes no row
 * — the log carries no structured path for it, and a row invented from a
 * preview string would be a lie about which file was touched.
 */
import type { ToolCall } from '@noa/core';

/** One file operation a tool call performs, when the call's own arguments say so. */
export interface FileOp {
  kind: 'read' | 'write' | 'search';
  /** The file (read/write) or the directory scanned (search). */
  path: string;
  /** Lines the call's arguments add (write/edit only). */
  added?: number;
  /** Lines the call's arguments remove (edit only). */
  removed?: number;
}

/** Lines in a text block; the empty string is zero lines, not one. */
function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The op one call performs, or undefined when the tool touches no named file.
 * @param call - one tool call as the log recorded it.
 * @returns the op, with line counts when the arguments carry the text.
 */
export function fileOpOfCall(call: ToolCall): FileOp | undefined {
  const args = call.args;
  switch (call.name) {
    case 'read_file': {
      const path = str(args['path']);
      return path === undefined ? undefined : { kind: 'read', path };
    }
    case 'write_file': {
      const path = str(args['path']);
      if (path === undefined) return undefined;
      // The file did not exist before the write, so the whole body reads as
      // added: that is what the diff of a create shows a reader.
      return { kind: 'write', path, added: lineCount(typeof args['content'] === 'string' ? args['content'] : '') };
    }
    case 'edit_file': {
      const path = str(args['path']);
      if (path === undefined) return undefined;
      return {
        kind: 'write',
        path,
        added: lineCount(typeof args['new_string'] === 'string' ? args['new_string'] : ''),
        removed: lineCount(typeof args['old_string'] === 'string' ? args['old_string'] : ''),
      };
    }
    case 'search_files': {
      // The scan's own scope, not the files it happened to match: the matches
      // are a property of the workspace at that moment, and the log records
      // them only as result text this module deliberately does not parse.
      return { kind: 'search', path: str(args['path']) ?? '.' };
    }
    default:
      return undefined;
  }
}
