import { describe, expect, it } from 'vitest';
import { snapshotJson } from '../src/json.js';

describe('snapshotJson __proto__ handling', () => {
  it('keeps __proto__ as an own enumerable key instead of dropping it or polluting the prototype', () => {
    const src: Record<string, unknown> = {};
    Object.defineProperty(src, '__proto__', { enumerable: true, value: { polluted: true } });
    src['a'] = 1;

    const snap = snapshotJson(src) as Record<string, unknown> | undefined;
    expect(snap).toBeDefined();
    // The snapshot must stay a plain object…
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    // …and `__proto__` must survive as a real own key (JSON round-trip keeps it).
    expect(Object.hasOwn(snap!, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(snap))).toMatchObject({ a: 1 });
    expect(JSON.stringify(snap)).toContain('__proto__');
  });
});
