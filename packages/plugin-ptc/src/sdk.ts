/**
 * PTC mode codegen: the pure projection from registered tool schemas to the
 * TypeScript SDK text the model programs against (dsh ts-types.ts simplified).
 * Native tool schemas and this generated `declare const tools` API are two
 * projections of the same store. Tools are emitted in lexicographic name
 * order with schema descriptions folded into JSDoc, so an unchanged tool set
 * produces byte-identical text across turns — the stable-prefix cache rule.
 */

import type { ToolDefinition } from '@noa/core';

/** The model-facing name of the PTC transport tool. */
export const RUN_CODE_NAME = 'run_code';

/** Property names that are valid bare TS identifiers are unquoted; everything else is quoted (every name stays reachable, no aliasing). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function pad(indent: number): string {
  return '  '.repeat(indent);
}

/** One collapsed-line JSDoc for a schema description; comment closers are escaped so prose cannot terminate the generated comment. */
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return [];
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`];
}

/** Whether a rendered member type must be parenthesized before `[]` or object use. */
function needsParens(rendered: string): boolean {
  return rendered.includes('|') || rendered.startsWith('{');
}

/** Depth cap: deeper recursion renders `unknown` instead of risking a stack overflow on hostile schemas. */
const MAX_TYPE_DEPTH = 24;

/**
 * Map a JSON-Schema subset to a TypeScript type literal. Unsupported or
 * malformed constructs degrade to `unknown` — never a throw: the SDK is
 * advisory anyway (the program runs type-stripped).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0, depth = 0): string {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return 'unknown';
  if (depth > MAX_TYPE_DEPTH) return 'unknown';
  const node = schema as Record<string, unknown>;
  const variants = Array.isArray(node['oneOf']) ? node['oneOf'] : Array.isArray(node['anyOf']) ? node['anyOf'] : undefined;
  if (variants !== undefined && variants.length > 0) {
    return variants.map((v) => jsonSchemaToTs(v, indent, depth + 1)).join(' | ');
  }
  if ('const' in node) return JSON.stringify(node['const']);
  if (Array.isArray(node['enum'])) {
    const literals = node['enum'].map((v) => JSON.stringify(v)).join(' | ');
    return literals.length > 0 ? literals : 'unknown';
  }
  switch (node['type']) {
    case 'string':
    case 'boolean':
      return node['type'];
    case 'number':
    case 'integer':
      return 'number';
    case 'null':
      return 'null';
    case 'array': {
      const items = jsonSchemaToTs(node['items'], indent, depth + 1);
      return needsParens(items) ? `(${items})[]` : `${items}[]`;
    }
    case 'object': {
      const props = node['properties'];
      const required = new Set(Array.isArray(node['required']) ? (node['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : []);
      const open = node['additionalProperties'] !== false;
      const entries = typeof props === 'object' && props !== null ? Object.entries(props as Record<string, unknown>) : [];
      if (entries.length === 0) return open ? 'Record<string, JsonValue>' : 'Record<string, never>';
      const lines: string[] = ['{'];
      for (const [name, prop] of entries) {
        lines.push(...docLines((prop as Record<string, unknown>)?.['description'], indent + 1));
        lines.push(`${pad(indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: ${jsonSchemaToTs(prop, indent + 1, depth + 1)};`);
      }
      lines.push(`${pad(indent)}}`);
      const declared = lines.join('\n');
      return open ? `${declared} & Record<string, JsonValue>` : declared;
    }
    default:
      // No declared type: free-form JSON.
      return 'JsonValue';
  }
}

/**
 * The fixed model-facing usage contract rendered above the declarations.
 * Adapted from dsh: NovaAgent tools resolve to their result TEXT (a string),
 * and the failure path is the injected `ToolCallError`.
 */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` executes a TypeScript program you write against the tools below. Takes two required arguments: \`code\` — the BODY of an async function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped; top-level \`await\` and \`return\` work) — and \`description\`, a short summary of what the program does. A declaration below does not make its name a directly callable tool; only tools sent as separate native schemas may be called directly.

Inside the program:
- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's result TEXT (a string).
- A FAILED call (denied at the approval gate, unknown tool, run over) rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (tools that declare concurrency safety overlap up to a cap; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return enters the conversation — every intermediate result stays out of it, so extract just what you need.

Program-only SDK bindings:`;

/**
 * Render the SDK prompt section for the current tool set: the usage contract
 * plus a `declare const tools` covering every tool except `run_code` itself.
 * Deterministic (lexicographic order) for cache stability.
 *
 * In `both` mode (native schemas also sent), `slim` = true skips the full
 * parameter type declarations — the model already has the native schemas, so
 * the SDK binding only lists tool names + first description line. This keeps
 * the section byte-stable (same tool list → same bytes) while saving context.
 */
export function renderToolsSdk(tools: ToolDefinition[], opts?: { slim?: boolean }): string {
  const slim = opts?.slim === true;
  const sorted = [...tools]
    .filter((tool) => tool.name !== RUN_CODE_NAME)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const members: string[] = [];
  for (const tool of sorted) {
    if (slim) {
      // First line of description only — the full parameter types live in the
      // native schema the model already sees.
      members.push(...docLines(tool.description.split('\n')[0] ?? '', 1));
      members.push(`${pad(1)}${renderKey(tool.name)}: Record<string, unknown>;`);
    } else {
      members.push(...docLines(tool.description, 1));
      members.push(`${pad(1)}${renderKey(tool.name)}: ${jsonSchemaToTs(tool.parameters, 1)};`);
    }
  }
  const argsMap = `interface ToolArgsMap {${members.length > 0 ? `\n${members.join('\n')}\n}` : ''}}`;
  const declaration = [
    argsMap,
    'type ToolName = keyof ToolArgsMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<string>;', '}'].join('\n'),
  ].join('\n\n');
  const jsonValue =
    'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }';
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`ts\n${jsonValue}\n\n${declaration}\n\`\`\``;
}
