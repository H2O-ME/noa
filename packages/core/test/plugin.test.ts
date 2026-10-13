import { describe, expect, it, vi } from 'vitest';
import { Context, ServiceUnavailable, event, key, type Plugin } from '../src/plugin/index.js';

interface Counter {
  value: number;
}
const counter = key<Counter>('counter');
const silent = { log: () => undefined };

describe('services', () => {
  it('resolves a provided service and reports absence by name', () => {
    const root = Context.createRoot(silent);
    root.plugin({
      name: 'provider',
      apply: (ctx) => {
        ctx.provide(counter, { value: 7 });
      },
    });
    expect(root.must(counter).value).toBe(7);
    expect(root.get('never-registered')).toBeUndefined();
    expect(() => root.must(key<Counter>('missing'))).toThrow(/service "missing" is not available/);
  });

  it('names the requiring plugin when a declared service is absent', async () => {
    const root = Context.createRoot(silent);
    await root
      .plugin({
        name: 'reader',
        inject: [counter],
        apply: (ctx) => {
          ctx.must(counter);
        },
      })
      .ready.catch(() => undefined);
    expect(root.unsatisfied()).toContain('counter');
    const roster = root.roster().find((entry) => entry.name === 'reader');
    expect(roster?.state).toBe('failed');
  });

  it('reloads dependents when the provider is replaced', async () => {
    const root = Context.createRoot(silent);
    const seen: number[] = [];
    const first = root.plugin({
      name: 'first-provider',
      apply: (ctx) => {
        ctx.provide(counter, { value: 1 });
      },
    });
    root.plugin({
      name: 'reader',
      inject: [counter],
      apply: (ctx) => {
        seen.push(ctx.must(counter).value);
      },
    });
    expect(seen).toEqual([1]);
    await first.dispose();
    await root
      .plugin({
        name: 'second-provider',
        apply: (ctx) => {
          ctx.provide(counter, { value: 2 });
        },
      })
      .ready;
    expect(seen).toEqual([1, 2]);
  });

  it('rejects a duplicate provider in the same scope', async () => {
    const root = Context.createRoot(silent);
    root.plugin({
      name: 'a',
      apply: (ctx) => {
        ctx.provide(counter, { value: 1 });
      },
    });
    await expect(
      root
        .plugin({
          name: 'b',
          apply: (ctx) => {
            ctx.provide(counter, { value: 2 });
          },
        })
        .ready,
    ).rejects.toThrow(/already provided by plugin "a"/);
  });

  it('isolates a service inside a child scope', () => {
    const root = Context.createRoot(silent);
    root.plugin({
      name: 'provider',
      apply: (ctx) => {
        ctx.provide(counter, { value: 1 });
        const scoped = ctx.isolate('counter');
        scoped.provide(counter, { value: 99 });
        expect(scoped.must(counter).value).toBe(99);
        expect(ctx.must(counter).value).toBe(1);
      },
    });
  });
});

describe('effects and teardown', () => {
  it('unwinds registrations in reverse on dispose', async () => {
    const root = Context.createRoot(silent);
    const order: string[] = [];
    const fiber = root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.effect(() => () => order.push('first'), 'first');
        ctx.effect(() => () => order.push('second'), 'second');
      },
    });
    await fiber.dispose();
    expect(order).toEqual(['second', 'first']);
  });

  it('reports a failing undo and still runs the remaining ones', async () => {
    const lines: string[] = [];
    const root = Context.createRoot({ log: (level, message) => lines.push(`${level}:${message}`) });
    const order: string[] = [];
    const fiber = root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.effect(() => () => order.push('first'), 'first');
        ctx.effect(() => () => {
          throw new Error('undo blew up');
        }, 'broken');
      },
    });
    await fiber.dispose();
    // Reverse order, so the broken undo runs first: it is REPORTED and the older
    // one still runs. A teardown that only half-ran used to leave no trace at all.
    expect(order).toEqual(['first']);
    expect(lines).toEqual(['warn:plugin "p" failed to undo broken: undo blew up']);
  });

  it('reports a failing undo on the root scope too', async () => {
    const lines: string[] = [];
    const root = Context.createRoot({ log: (level, message) => lines.push(`${level}:${message}`) });
    const undo = root.effect(() => () => {
      throw new Error('assembly undo blew up');
    }, 'assembly-thing');
    await undo();
    expect(lines).toEqual(['warn:assembly effect "assembly-thing" failed to undo: assembly undo blew up']);
  });

  it('removes a service when its provider unloads', async () => {
    const root = Context.createRoot(silent);
    const fiber = root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.provide(counter, { value: 1 });
      },
    });
    expect(root.get(counter)).toBeDefined();
    await fiber.dispose();
    expect(root.get(counter)).toBeUndefined();
  });

  it('disposes children with their parent', async () => {
    const root = Context.createRoot(silent);
    let childGone = false;
    const parent = root.plugin({
      name: 'parent',
      apply: (ctx) => {
        const child = ctx.plugin({
          name: 'child',
          apply: (inner) => {
            inner.effect(
              () => () => {
                childGone = true;
              },
              'child-effect',
            );
          },
        });
        expect(child.state).toBe('active');
      },
    });
    await parent.dispose();
    expect(childGone).toBe(true);
  });

  it('leaves no trace when a plugin throws mid-activation', async () => {
    const root = Context.createRoot(silent);
    await expect(
      root
        .plugin({
          name: 'half',
          apply: (ctx) => {
            ctx.provide(counter, { value: 1 });
            throw new Error('boom');
          },
        })
        .ready,
    ).rejects.toThrow('boom');
    expect(root.get(counter)).toBeUndefined();
  });

  it('refuses registration after disposal', async () => {
    const root = Context.createRoot(silent);
    let late: (() => void) | undefined;
    const fiber = root.plugin({
      name: 'p',
      apply: (ctx) => {
        late = () => ctx.effect(() => () => undefined, 'late');
      },
    });
    await fiber.dispose();
    expect(late).toThrow(/while disposed/);
  });

  it('activates a synchronous body before ctx.plugin returns', () => {
    const root = Context.createRoot(silent);
    const fiber = root.plugin({
      name: 'sync',
      apply: (ctx) => {
        ctx.provide(counter, { value: 3 });
      },
    });
    expect(fiber.state).toBe('active');
    expect(root.get(counter)).toBeDefined();
  });
});

describe('config', () => {
  const schema = {
    '~standard': {
      validate: (value: unknown) =>
        typeof (value as { port?: unknown }).port === 'number'
          ? { value: value as { port: number } }
          : { issues: [{ message: 'port must be a number' }] },
    },
  };

  it('validates and hands the plugin its config', () => {
    const root = Context.createRoot(silent);
    let seen = 0;
    root.plugin(
      {
        name: 'p',
        Config: schema,
        apply: (_ctx, config: { port: number }) => {
          seen = config.port;
        },
      },
      { port: 8080 },
    );
    expect(seen).toBe(8080);
  });

  it('fails loud with the plugin name on an invalid config', async () => {
    const root = Context.createRoot(silent);
    await expect(
      root.plugin({ name: 'p', Config: schema, apply: () => undefined }, { port: 'nope' }).ready,
    ).rejects.toThrow(/invalid config for plugin "p": port must be a number/);
  });

  it('accepts an async config schema', async () => {
    const root = Context.createRoot(silent);
    let seen = 0;
    const fiber = root.plugin(
      {
        name: 'p',
        Config: {
          '~standard': {
            validate: async (value: unknown) => ({ value: value as { port: number } }),
          },
        },
        apply: (_ctx, config: { port: number }) => {
          seen = config.port;
        },
      },
      { port: 9 },
    );
    expect(fiber.state).toBe('loading');
    await fiber.ready;
    expect(seen).toBe(9);
  });
});

describe('events', () => {
  it('emits to every listener and contains their errors', () => {
    const errors: string[] = [];
    const root = Context.createRoot({
      log: (level, message) => {
        if (level === 'error') errors.push(message);
      },
    });
    const ping = event<[number], void>('ping');
    const seen: number[] = [];
    root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.on(ping, (n) => void seen.push(n));
        ctx.on(ping, () => {
          throw new Error('listener blew up');
        });
      },
    });
    root.emit(ping, 3);
    expect(seen).toEqual([3]);
    expect(errors[0]).toMatch(/listener for "ping" threw/);
  });

  it('runs a waterfall in order, letting a listener delegate or win', async () => {
    const root = Context.createRoot(silent);
    const req = event<[string], string>('req');
    root.plugin({
      name: 'wrap',
      apply: (ctx) => {
        ctx.on(req, async (input: string, next: () => Promise<string>) => `a(${await next()})`);
        ctx.on(req, (input: string) => `b(${input})`);
      },
    });
    await expect(root.waterfall(req, 'x')).resolves.toBe('a(b(x))');
  });

  it('lets a listener veto by returning without delegating', async () => {
    const root = Context.createRoot(silent);
    const req = event<[string], string>('req');
    const reached: string[] = [];
    root.plugin({
      name: 'veto',
      apply: (ctx) => {
        ctx.on(req, () => 'denied');
        ctx.on(req, (input: string) => {
          reached.push(input);
          return 'ok';
        });
      },
    });
    await expect(root.waterfall(req, 'x')).resolves.toBe('denied');
    expect(reached).toEqual([]);
  });

  it('keeps a delegated rewrite when the chain ends (spread-style next)', async () => {
    // The runtime used to expect `next([args])` while its type and its own docs
    // said `next(...args)`, so the documented transformer silently passed a bare
    // object and every rewrite was dropped at the end of the chain — with the
    // caller's `?? original` hiding it. Both spellings must keep working, and a
    // rewrite reaching the end must survive.
    const root = Context.createRoot(silent);
    const req = event<[string], string>('req');
    root.plugin({
      name: 'transform',
      apply: (ctx) => {
        ctx.on(req, async (input: string, next: (v: string) => Promise<string>) => {
          const out = await next(`${input}+demo`);
          return out ?? input;
        });
      },
    });
    await expect(root.waterfall(req, 'base')).resolves.toBe('base+demo');
    // Two listeners: the first rewrites, the second observes the rewrite.
    const two = Context.createRoot(silent);
    const seen: string[] = [];
    two.plugin({
      name: 'chain',
      apply: (ctx) => {
        ctx.on(req, async (input: string, next: (v: string) => Promise<string>) => {
          const out = await next(`${input}+first`);
          return out ?? input;
        });
        ctx.on(req, (input: string) => {
          seen.push(input);
          return `${input}+second`;
        });
      },
    });
    await expect(two.waterfall(req, 'base')).resolves.toBe('base+first+second');
    expect(seen).toEqual(['base+first']);
  });

  it('stops a serial chain at the first non-empty answer', async () => {
    const root = Context.createRoot(silent);
    const ask = event<[], string | undefined>('ask');
    const order: number[] = [];
    root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.on(ask, () => {
          order.push(1);
          return undefined;
        });
        ctx.on(ask, () => {
          order.push(2);
          return 'first';
        });
        ctx.on(ask, () => {
          order.push(3);
          return 'second';
        });
      },
    });
    await expect(root.serial(ask)).resolves.toBe('first');
    expect(order).toEqual([1, 2]);
  });

  it('runs higher-priority listeners first', () => {
    const root = Context.createRoot(silent);
    const ping = event<[], void>('ping');
    const order: string[] = [];
    root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.on(ping, () => void order.push('low'), { priority: 0 });
        ctx.on(ping, () => void order.push('high'), { priority: 10 });
      },
    });
    root.emit(ping);
    expect(order).toEqual(['high', 'low']);
  });

  it('runs listeners in parallel and aggregates their failures', async () => {
    const root = Context.createRoot(silent);
    const work = event<[], void>('work');
    const done: string[] = [];
    root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.on(work, async () => {
          done.push('a');
        });
        ctx.on(work, async () => {
          done.push('b');
          throw new Error('b failed');
        });
      },
    });
    await expect(root.parallel(work)).rejects.toThrow(/b failed/);
    expect(done).toEqual(['a', 'b']);
  });

  it('drops a listener when its plugin unloads', async () => {
    const root = Context.createRoot(silent);
    const ping = event<[], void>('ping');
    let count = 0;
    const fiber = root.plugin({
      name: 'p',
      apply: (ctx) => {
        ctx.on(ping, () => {
          count += 1;
        });
      },
    });
    root.emit(ping);
    await fiber.dispose();
    root.emit(ping);
    expect(count).toBe(1);
  });
});

describe('plugin shapes', () => {
  it('accepts a class provider', () => {
    const root = Context.createRoot(silent);
    class Provider {
      static name = 'classy';
      constructor(ctx: Context) {
        ctx.provide(counter, { value: 5 });
      }
    }
    root.plugin(Provider as unknown as Plugin);
    expect(root.must(counter).value).toBe(5);
  });

  it('accepts an object with apply() and a bare function', () => {
    const root = Context.createRoot(silent);
    const seen = vi.fn();
    root.plugin({ name: 'obj', apply: seen });
    root.plugin((ctx: Context) => ctx.provide(counter, { value: 1 }), {}, 'fn');
    expect(seen).toHaveBeenCalledOnce();
    expect(root.roster().map((entry) => entry.name)).toContain('fn');
  });
});

describe('loud failures', () => {
  it('reports a missing declared service as ServiceUnavailable', () => {
    const root = Context.createRoot(silent);
    root.plugin({ name: 'noop', apply: () => undefined });
    expect(() => root.must(counter)).toThrow(ServiceUnavailable);
  });

  it('is not a thenable, so awaiting it cannot recurse', () => {
    const root = Context.createRoot(silent);
    const fiber = root.plugin({ name: 'p', apply: () => undefined });
    expect(typeof (fiber as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('reports an async body failure through ready and the roster', async () => {
    const root = Context.createRoot(silent);
    const fiber = root.plugin({
      name: 'slow',
      apply: async () => {
        throw new Error('late boom');
      },
    });
    expect(fiber.state).toBe('loading');
    await expect(fiber.ready).rejects.toThrow('late boom');
    expect(fiber.state).toBe('failed');
  });

  /**
   * The stderr EXIT, not the escape helper: `Context.createRoot()` with no `log`
   * option is the default writer every surface inherits, and this drives it.
   *
   * The message is the shape `loader.ts` writes — a row id plus the plugin's own
   * thrown text, i.e. external data on both halves. Removing the `oneLineText`
   * call in `context.ts` leaves live control code points in these bytes and this
   * test goes red.
   */
  it('escapes control code points at the stderr exit', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write);
    try {
      const root = Context.createRoot();
      root.log('error', 'plugin "bad\u001b[31m" failed to load: boom \u001b[31mRED\rOVERWRITTEN\u0007\u009b31m\u007fend\nSECOND');
    } finally {
      spy.mockRestore();
    }
    const nova = written.filter((line) => line.startsWith('[nova:'));
    expect(nova).toHaveLength(1);
    const line = nova[0] as string;
    // The static prefix is this file's own literal — only `message` is escaped.
    expect(line.startsWith('[nova:error] plugin "bad')).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    // Each hazard as a VISIBLE escape: `\r` cannot overwrite, ANSI cannot recolour.
    expect(line).toContain('\\x1b[31m');
    expect(line).toContain('\\r');
    expect(line).toContain('\\x07');
    expect(line).toContain('\\x9b');
    expect(line).toContain('\\x7f');
    expect(line).toContain('\\nSECOND');
    // No live control code point survives to stderr (the terminator excepted).
    const live = Array.from(line.slice(0, -1)).some((ch) => {
      const code = ch.codePointAt(0) ?? 0x20;
      return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    expect(live).toBe(false);
  });
});
describe('fiber activation lifecycle', () => {
  it('a dispose during an async apply cannot resurrect the fiber', async () => {
    const root = Context.createRoot(silent);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fiber = root.plugin({ name: 'slow', apply: () => gate });
    expect(fiber.state).toBe('loading');
    await fiber.dispose();
    // The in-flight body finishes AFTER the dispose: it must not flip the fiber
    // back to `active`, or a torn-down plugin would look loaded (and a later
    // refresh would skip the reload it needs).
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fiber.state).toBe('disposed');
  });
});
