import { describe, expect, it } from 'vitest';
import { JobRegistry, formatJobNotices, type JobNotice, type JobOutcome } from '../src/index.js';

function deferred(): { promise: Promise<JobOutcome>; resolve: (o: JobOutcome) => void } {
  let resolve!: (o: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('JobRegistry', () => {
  it('assigns kind-prefixed ids and tracks lifecycle to completion', async () => {
    const registry = new JobRegistry();
    const d = deferred();
    const snapshot = registry.start({
      kind: 'bash', sessionId: '',
      label: 'sleep 10',
      cancel: () => {},
      done: d.promise,
    });
    expect(snapshot.id).toBe('bash-1');
    expect(snapshot.status).toBe('running');

    d.resolve({ status: 'completed', detail: 'exit code: 0' });
    await d.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('bash-1')?.status).toBe('completed');
    expect(registry.get('bash-1')?.detail).toBe('exit code: 0');
  });

  it('snapshots carry startedAt and a FRESH progress peek on every list/get', () => {
    const registry = new JobRegistry();
    let progress = '1 tools · bash ls';
    const d = deferred();
    registry.start({
      kind: 'subagent', sessionId: '',
      label: '[subagent: scout] brief',
      cancel: () => {},
      done: d.promise,
      progress: () => progress,
    });
    const first = registry.get('subagent-1');
    expect(first?.startedAt).toBeGreaterThan(0);
    expect(first?.progress).toBe('1 tools · bash ls');
    // the accessor is re-read per snapshot (UI live rows sample it per tick)
    progress = '2 tools · read_file a.ts';
    expect(registry.get('subagent-1')?.progress).toBe('2 tools · read_file a.ts');
    expect(registry.list()[0]?.progress).toBe('2 tools · read_file a.ts');
  });

  it('stop() marks stopping, is idempotent, and settles as killed', async () => {
    const registry = new JobRegistry();
    let cancelCalls = 0;
    const d = deferred();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'long task',
      cancel: () => {
        cancelCalls += 1;
        d.resolve({ status: 'killed', detail: 'exit code: null' });
      },
      done: d.promise,
    });

    await registry.stop('bash-1');
    await registry.stop('bash-1');
    expect(cancelCalls).toBe(1);
    await d.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('bash-1')?.status).toBe('killed');
  });

  it('readOutput returns only output produced since the previous call', () => {
    const registry = new JobRegistry();
    let buffer = '';
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'producer',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed' }),
      readOutput: () => {
        const chunk = buffer;
        buffer = '';
        return chunk;
      },
    });
    // simulate producer writes through the shared closure
    buffer = 'hello ';
    expect(registry.readOutput('bash-1')).toBe('hello ');
    expect(registry.readOutput('bash-1')).toBe('');
    buffer = 'world';
    expect(registry.readOutput('bash-1')).toBe('world');
  });

  it('keeps the subagent kind reserved and fails unknown job lookups gracefully', () => {
    const registry = new JobRegistry();
    const snapshot = registry.start({
      kind: 'subagent', sessionId: '',
      label: 'explore',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed' }),
    });
    expect(snapshot.kind).toBe('subagent');
    expect(registry.get(snapshot.id)?.kind).toBe('subagent');
    expect(registry.get('bash-99')).toBeUndefined();
    expect(registry.readOutput('bash-99')).toBeUndefined();
  });
});

describe('JobRegistry completion notices', () => {
  async function flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('queues each completed/failed job once, in settlement order, and drains it exactly once', async () => {
    const registry = new JobRegistry();
    const a = deferred();
    const b = deferred();
    registry.start({ kind: 'bash', sessionId: '', label: 'sleep 10', cancel: () => {}, done: a.promise });
    registry.start({ kind: 'bash', sessionId: '', label: 'curl site', cancel: () => {}, done: b.promise });

    expect(registry.drainFinished()).toEqual([]); // nothing before settlement
    a.resolve({ status: 'completed', detail: 'exit code: 0' });
    b.resolve({ status: 'failed', detail: 'exit code: 3' });
    await a.promise;
    await b.promise;
    await flush();

    const notices = registry.drainFinished();
    expect(notices.map((n) => n.id)).toEqual(['bash-1', 'bash-2']);
    expect(notices[0]).toMatchObject({ kind: 'bash', sessionId: '', status: 'completed', detail: 'exit code: 0' });
    expect(notices[1]).toMatchObject({ status: 'failed', detail: 'exit code: 3' });
    expect(registry.drainFinished()).toEqual([]); // one drain = one announcement
  });

  it('requeue puts a failed delivery back at the head, keeping order and later drains', async () => {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'curl site',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
    });
    await flush();

    const first = registry.drainFinished();
    expect(first.map((n) => n.id)).toEqual(['bash-1']);
    registry.requeue(first); // the carrying request died before the model saw it
    const again = registry.drainFinished();
    expect(again).toEqual(first); // identical batch, delivered at-least-once now

    // A fresh notice queues behind the requeued one, and requeue([]) is a no-op.
    registry.start({ kind: 'bash', sessionId: '', label: 'second', cancel: () => {}, done: Promise.resolve({ status: 'completed' }) });
    await flush();
    registry.requeue(first);
    registry.requeue([]);
    expect(registry.drainFinished().map((n) => n.id)).toEqual(['bash-1', 'bash-2']);
    expect(registry.drainFinished()).toEqual([]);
  });

  it('does not announce a stop-initiated kill (the model already knows it stopped)', async () => {
    const registry = new JobRegistry();
    const d = deferred();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'long task',
      cancel: () => d.resolve({ status: 'killed', detail: 'exit code: null' }),
      done: d.promise,
    });
    await registry.stop('bash-1');
    await d.promise;
    await flush();
    expect(registry.get('bash-1')?.status).toBe('killed');
    expect(registry.drainFinished()).toEqual([]);
  });

  it('announces a producer-bug rejection as a failed job', async () => {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'buggy producer',
      cancel: () => {},
      done: Promise.reject(new Error('boom')),
    });
    await flush();
    const notices = registry.drainFinished();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: 'failed', detail: 'boom' });
  });

  it('formatJobNotices renders jobs-list-shaped rows with the output hint', () => {
    const notices: JobNotice[] = [
      { id: 'bash-1', kind: 'bash', sessionId: '', label: 'sleep 10', status: 'completed', detail: 'exit code: 0' },
    ];
    expect(formatJobNotices(notices)).toBe(
      [
        'Background job finished:',
        '- bash-1 [completed] sleep 10 (exit code: 0)',
        'Read the output with the jobs tool (action=output, id=<id>) as needed.',
      ].join('\n'),
    );
  });

  it('truncates over-long command labels and handles multiple jobs', () => {
    const long = 'x'.repeat(90);
    const text = formatJobNotices([
      { id: 'bash-1', kind: 'bash', sessionId: '', label: long, status: 'completed' },
      { id: 'bash-2', kind: 'bash', sessionId: '', label: 'second', status: 'failed', detail: 'exit code: 1' },
    ]);
    expect(text).toContain(`- bash-1 [completed] ${'x'.repeat(79)}…`);
    expect(text).toContain('- bash-2 [failed] second (exit code: 1)');
    expect(text.startsWith('Background jobs finished:')).toBe(true);
  });
});
