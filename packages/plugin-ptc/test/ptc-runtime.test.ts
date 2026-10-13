/**
 * Real-worker tests for the PTC code runtime: every outcome of the seam
 * contract (value/logs, exception, budgets, abort, hostile bindings) is
 * exercised through actual worker threads.
 */
import { describe, expect, it } from 'vitest';
import { typeStrippingAvailable } from '@noa/core';
import { DEFAULT_CODE_RUNTIME_CONFIG, resolveCodeRuntimeConfig, runCode } from '../src/index.js';
import type { CodeBindingNamespace, CodeRuntimeConfig, JsonValue } from '../src/index.js';

function config(overrides: Partial<CodeRuntimeConfig> = {}): CodeRuntimeConfig {
  return { ...DEFAULT_CODE_RUNTIME_CONFIG, ...overrides };
}

const echoNs = (calls: unknown[]): CodeBindingNamespace => {
  // defineProperty, not an object literal: `__proto__:` as a LITERAL key hits
  // the prototype setter instead of creating an own property.
  const functions = Object.create(null) as CodeBindingNamespace['functions'];
  functions['echo'] = async (args): Promise<JsonValue> => {
    calls.push(args);
    return (args as { text?: string })?.text ?? 'echo';
  };
  functions['fail'] = async (): Promise<JsonValue> => {
    throw new Error('boom');
  };
  Object.defineProperty(functions, '__proto__', {
    enumerable: true,
    value: async (): Promise<JsonValue> => 'proto-ok',
  });
  return {
    global: 'tools',
    functions,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  };
};

describe('code runtime (worker thread)', () => {
  it('is available on the test Node', () => {
    expect(typeStrippingAvailable()).toBe(true);
  });

  it('returns the completion value and captured logs', async () => {
    const result = await runCode(
      { program: "console.log('hello'); return 42;", bindings: [] },
      config(),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
    expect(result.logs).toEqual(['hello']);
  });

  it('runs typed (type-stripped) programs with top-level await', async () => {
    const result = await runCode(
      { program: 'const n: number = await Promise.resolve(7);\nreturn { n, list: [n] as number[] };', bindings: [] },
      config(),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ n: 7, list: [7] });
  });

  it('reports non-erasable syntax (enum) as a program exception, no worker spawn', async () => {
    const result = await runCode({ program: 'enum A { X }\nreturn A.X;', bindings: [] }, config());
    expect(result.error?.kind).toBe('exception');
  });

  it('reports thrown programs as exception failures with the stack message', async () => {
    const result = await runCode({ program: "throw new Error('kaput');", bindings: [] }, config());
    expect(result.error?.kind).toBe('exception');
    expect(result.error?.message).toContain('kaput');
  });

  it('bridges binding calls round-trip', async () => {
    const calls: unknown[] = [];
    const result = await runCode(
      { program: "const a = await tools.echo({ text: 'ping' });\nreturn a.toUpperCase();", bindings: [echoNs(calls)] },
      config(),
    );
    expect(result.value).toBe('PING');
    expect(calls).toEqual([{ text: 'ping' }]);
  });

  it('survives binding names that collide with Object.prototype', async () => {
    const calls: unknown[] = [];
    const result = await runCode(
      { program: "return await tools.__proto__({});", bindings: [echoNs(calls)] },
      config(),
    );
    expect(result.value).toBe('proto-ok');
  });

  it('rejects failed binding calls as the injected ToolCallError class', async () => {
    const calls: unknown[] = [];
    const result = await runCode(
      {
        program:
          "try { await tools.fail({}); return 'no-throw'; } catch (e) { return [e instanceof ToolCallError, e.name, e.toolName, e.message]; }",
        bindings: [echoNs(calls)],
      },
      config(),
    );
    expect(result.value).toEqual([true, 'ToolCallError', 'fail', 'boom']);
  });

  it('rejects lossy binding arguments inside the program', async () => {
    const calls: unknown[] = [];
    const result = await runCode(
      {
        program: "try { await tools.echo(() => 1); return 'no-throw'; } catch (e) { return e.message; }",
        bindings: [echoNs(calls)],
      },
      config(),
    );
    expect(result.value).toContain('lossless JSON');
    expect(calls).toEqual([]);
  });

  it('a missing binding name is an ordinary catchable TypeError inside the program', async () => {
    const calls: unknown[] = [];
    const result = await runCode(
      { program: "try { await tools.nope({}); return 'no-throw'; } catch (e) { return e.name; }", bindings: [echoNs(calls)] },
      config(),
    );
    expect(result.value).toBe('TypeError');
  });

  it('fails the run on a non-JSON completion value', async () => {
    const result = await runCode({ program: 'return Number.NaN;', bindings: [] }, config());
    expect(result.error?.kind).toBe('invalid-output');
    expect(result.value).toBeUndefined();
  });

  it('treats undefined as absence, not invalid output', async () => {
    const result = await runCode({ program: "console.log('only-log');", bindings: [] }, config());
    expect(result.error).toBeUndefined();
    expect(result.value).toBeUndefined();
    expect(result.logs).toEqual(['only-log']);
  });

  it('enforces the compute (busy-time) budget on a hot loop', async () => {
    const result = await runCode({ program: 'let x = 0;\nwhile (true) { x = x + 1; }', bindings: [] }, config({ computeMs: 600 }));
    expect(result.error?.kind).toBe('timeout');
    expect(result.error?.message).toContain('compute budget');
  }, 20_000);

  it('enforces the wall-clock ceiling while the program idles on a promise', async () => {
    const result = await runCode(
      { program: 'await new Promise(() => undefined);', bindings: [] },
      config({ maxWallMs: 800, computeMs: 60_000 }),
    );
    expect(result.error?.kind).toBe('timeout');
    expect(result.error?.message).toContain('wall-clock');
  }, 20_000);

  it('resolves aborted runs as the abort kind', async () => {
    const controller = new AbortController();
    const running = runCode(
      { program: 'await new Promise((r) => setTimeout(r, 10_000));', bindings: [], signal: controller.signal },
      config(),
    );
    setTimeout(() => controller.abort('user interrupt'), 150);
    const result = await running;
    expect(result.error?.kind).toBe('abort');
  }, 20_000);

  it('caps the combined outer output', async () => {
    const result = await runCode(
      { program: "console.log('x'.repeat(5000));\nreturn 'tail';", bindings: [] },
      config({ maxOutputBytes: 256 }),
    );
    expect(result.error?.kind).toBe('output-limit');
    expect(result.logs.length).toBeLessThanOrEqual(1);
  });

  it('validates binding globals as identifiers and rejects duplicates', async () => {
    const ns = (global: string): CodeBindingNamespace => ({ global, functions: { go: async () => 1 } });
    await expect(runCode({ program: 'return 1;', bindings: [ns('$tools')] }, config())).rejects.toThrow(/identifier/);
    await expect(runCode({ program: 'return 1;', bindings: [ns('a'), ns('a')] }, config())).rejects.toThrow(/identifier/);
  });

  it('rejects invalid runtime config up front', () => {
    expect(() => resolveCodeRuntimeConfig({ computeMs: -1 })).toThrow(/computeMs/);
    expect(() => resolveCodeRuntimeConfig({ maxWallMs: 3_000_000_000 })).toThrow(/maxWallMs/);
    expect(() => resolveCodeRuntimeConfig({ maxOutputBytes: 10 })).toThrow(/maxOutputBytes/);
  });
});
