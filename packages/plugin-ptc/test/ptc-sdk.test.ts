import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@noa/core';
import { RUN_CODE_NAME, jsonSchemaToTs, renderToolsSdk } from '../src/index.js';

function tool(name: string, parameters: Record<string, unknown>, description = ''): ToolDefinition {
  return { name, description, parameters, execute: () => 'x' };
}

describe('jsonSchemaToTs', () => {
  it('maps scalars, enums and consts', () => {
    expect(jsonSchemaToTs({ type: 'string' })).toBe('string');
    expect(jsonSchemaToTs({ type: 'integer' })).toBe('number');
    expect(jsonSchemaToTs({ type: 'boolean' })).toBe('boolean');
    expect(jsonSchemaToTs({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(jsonSchemaToTs({ type: 'string', const: 'fixed' })).toBe('"fixed"');
  });

  it('maps arrays, parenthesizing unions and objects', () => {
    expect(jsonSchemaToTs({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(jsonSchemaToTs({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } })).toBe('("a" | "b")[]');
    const objects = jsonSchemaToTs({ type: 'array', items: { type: 'object', additionalProperties: false } });
    expect(objects).toBe('Record<string, never>[]');
  });

  it('maps objects with required markers, optional keys and open extras', () => {
    const closed = jsonSchemaToTs({
      type: 'object',
      properties: { command: { type: 'string' }, flag: { type: 'boolean' } },
      required: ['command'],
      additionalProperties: false,
    });
    expect(closed).toContain('command: string;');
    expect(closed).toContain('flag?: boolean;');
    expect(closed).not.toContain('Record<string, JsonValue>');
    const open = jsonSchemaToTs({ type: 'object', properties: { a: { type: 'number' } } });
    expect(open).toContain('& Record<string, JsonValue>');
  });

  it('quotes exotic keys and folds descriptions into JSDoc', () => {
    const rendered = jsonSchemaToTs({
      type: 'object',
      properties: { 'my-tool': { type: 'string', description: 'does  a\nthing' } },
      required: ['my-tool'],
      additionalProperties: false,
    });
    expect(rendered).toContain('"my-tool": string;');
    expect(rendered).toContain('/** does a thing */');
  });

  it('degrades hostile or unsupported schemas to unknown', () => {
    expect(jsonSchemaToTs('not a schema')).toBe('unknown');
    expect(jsonSchemaToTs(null)).toBe('unknown');
    expect(jsonSchemaToTs({ type: 'nonsense' })).toBe('JsonValue');
    // a schema with a description containing a comment closer cannot terminate JSDoc
    const evil = jsonSchemaToTs({
      type: 'object',
      properties: { k: { type: 'string', description: 'x */ y' } },
      additionalProperties: false,
    });
    expect(evil).not.toContain('*/ y');
    expect(evil).toContain('*\\/');
  });
});

describe('renderToolsSdk', () => {
  it('declares every tool except run_code, lexicographically, deterministically', () => {
    const tools = [
      tool('zzz', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }, 'last tool'),
      tool(RUN_CODE_NAME, { type: 'object' }, 'the transport'),
      tool('aaa', { type: 'object', properties: {}, additionalProperties: false }, 'first tool\nwith newline'),
    ];
    const sdk = renderToolsSdk(tools);
    expect(sdk).toContain('declare const tools');
    expect(sdk).toContain('ToolCallError');
    expect(sdk).toContain('await tools.name(args)');
    // run_code never binds itself
    expect(sdk).not.toContain(`${RUN_CODE_NAME}:`);
    // lexicographic order: aaa before zzz
    expect(sdk.indexOf('aaa:')).toBeLessThan(sdk.indexOf('zzz:'));
    // descriptions collapsed onto one JSDoc line
    expect(sdk).toContain('/** first tool with newline */');
    // deterministic: the same tool set renders byte-identical
    expect(renderToolsSdk([...tools].reverse())).toBe(sdk);
  });

  it('slim mode replaces parameter types with Record<string, unknown> for `both` mode', () => {
    const tools = [
      tool('aaa', { type: 'object', properties: { q: { type: 'string' }, r: { type: 'number' }, s: { type: 'array', items: { type: 'string' } } }, required: ['q'], additionalProperties: false }, 'first tool with a long description that wraps into the binding'),
    ];
    const full = renderToolsSdk(tools);
    const slim = renderToolsSdk(tools, { slim: true });
    // Full mode emits the parameter type ({ q: string; r: number; s: string[] }).
    expect(full).toContain('q: string');
    // Slim mode replaces types with Record<string, unknown>.
    expect(slim).toContain('Record<string, unknown>');
    expect(slim).not.toContain('q: string');
    // Determinism preserved.
    expect(renderToolsSdk([...tools].reverse(), { slim: true })).toBe(slim);
  });
});
