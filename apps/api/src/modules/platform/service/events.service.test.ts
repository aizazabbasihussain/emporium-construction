import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatform } from '../index.js';
import { createKernel, sequentialIds, type Kernel } from '../test-support.js';

let k: Kernel;
let applied: string[];

beforeAll(async () => {
  k = await createKernel();
}, 60_000);

// One database for the file; each test starts with an empty outbox and a fresh subscriber registry.
beforeEach(async () => {
  await k.db.exec('delete from sys_event_consumptions; delete from sys_outbox;');
  k.clock.set('2026-10-24T10:00:00Z');
  k.platform = createPlatform({ clock: k.clock, newId: sequentialIds() });
  applied = [];
});

const publish = (type = 'thing.created', payload: unknown = { n: 1 }) =>
  k.db.transaction((tx) => k.platform.events.publish({ type, payload }, tx));

const outbox = () =>
  k.db.query<{
    dispatched_at: Date | null;
    failed_at: Date | null;
    attempts: number;
    last_error: string | null;
  }>('select dispatched_at, failed_at, attempts, last_error from sys_outbox');

describe('outbox and dispatch (T-4)', () => {
  it('writes the event only if the transaction commits', async () => {
    await expect(
      k.db.transaction(async (tx) => {
        await k.platform.events.publish({ type: 'thing.created', payload: {} }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await outbox()).toHaveLength(0);
    await publish();
    expect(await outbox()).toHaveLength(1);
  });

  it('delivers to every subscriber once and marks the event dispatched', async () => {
    k.platform.events.subscribe(
      'thing.created',
      async (event) => {
        applied.push(`a:${event.id}`);
      },
      'a',
    );
    k.platform.events.subscribe(
      'thing.created',
      async (event, tx) => {
        await tx.query('select 1');
        applied.push(`b:${(event.payload as { n: number }).n}`);
      },
      'b',
    );
    const id = await publish();
    expect(await k.platform.events.dispatchDue(k.db)).toEqual({
      dispatched: 1,
      retrying: 0,
      failed: 0,
    });
    expect(applied).toEqual([`a:${id}`, 'b:1']);
    // Replaying the dispatcher does not apply the handlers again.
    expect(await k.platform.events.dispatchDue(k.db)).toEqual({
      dispatched: 0,
      retrying: 0,
      failed: 0,
    });
    expect(applied).toHaveLength(2);
  });

  it('does not re-run a handler that already consumed the event when another one failed', async () => {
    let bFails = true;
    k.platform.events.subscribe('thing.created', async () => void applied.push('a'), 'a');
    k.platform.events.subscribe(
      'thing.created',
      async () => {
        if (bFails) throw new Error('b is down');
        applied.push('b');
      },
      'b',
    );
    await publish();
    expect(await k.platform.events.dispatchDue(k.db)).toMatchObject({ retrying: 1 });
    bFails = false;
    k.clock.set('2026-10-24T10:00:02Z'); // after the 1 s backoff
    expect(await k.platform.events.dispatchDue(k.db)).toMatchObject({ dispatched: 1 });
    expect(applied).toEqual(['a', 'b']);
  });

  it('retries with backoff, then flags the event failed after 5 attempts', async () => {
    k.platform.events.subscribe(
      'thing.created',
      async () => {
        throw new Error('always down');
      },
      'broken',
    );
    await publish();
    const delaysSeconds = [1, 2, 4, 8];
    for (const [i, delay] of delaysSeconds.entries()) {
      expect(await k.platform.events.dispatchDue(k.db)).toMatchObject({ retrying: 1 });
      // Not due again before the backoff elapses.
      expect(await k.platform.events.dispatchDue(k.db)).toEqual({
        dispatched: 0,
        retrying: 0,
        failed: 0,
      });
      k.clock.set(new Date(k.clock.now().getTime() + delay * 1000).toISOString());
      expect((await outbox())[0]?.attempts).toBe(i + 1);
    }
    expect(await k.platform.events.dispatchDue(k.db)).toEqual({
      dispatched: 0,
      retrying: 0,
      failed: 1,
    });
    const [row] = await outbox();
    expect(row).toMatchObject({ attempts: 5 });
    expect(row?.failed_at).not.toBeNull();
    expect(row?.last_error).toContain('broken: always down');
    expect(await k.platform.events.listFailed(k.db)).toHaveLength(1);
    expect(await k.platform.events.dispatchDue(k.db)).toMatchObject({ failed: 0 });
  });

  it('records non-Error throws and dispatches events without subscribers', async () => {
    k.platform.events.subscribe(
      'weird',
      () => {
        throw 'plain string'; // eslint-disable-line @typescript-eslint/only-throw-error
      },
      'weird',
    );
    await publish('weird');
    await publish('nobody.listens');
    expect(await k.platform.events.dispatchDue(k.db)).toEqual({
      dispatched: 1,
      retrying: 1,
      failed: 0,
    });
    expect((await outbox()).some((r) => r.last_error === 'weird: plain string')).toBe(true);
  });

  it('retries a failed event on demand and rejects unknown or healthy events', async () => {
    k.platform.events.subscribe(
      'thing.created',
      async () => {
        throw new Error('down');
      },
      'broken',
    );
    const id = await publish();
    await k.db.query('update sys_outbox set failed_at = now(), attempts = 5 where id = $1', [id]);
    const requeued = await k.db.transaction((tx) => k.platform.events.retryFailed(id, tx));
    expect(requeued).toMatchObject({ attempts: 0, failed_at: null });
    await expect(
      k.db.transaction((tx) => k.platform.events.retryFailed(id, tx)),
    ).rejects.toMatchObject({ code: 'event_not_failed' });
    await expect(
      k.db.transaction((tx) =>
        k.platform.events.retryFailed('018f0000-0000-7000-8000-00000000ffff', tx),
      ),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('requires a handler name and rejects duplicate subscriptions', () => {
    expect(() => k.platform.events.subscribe('t', async () => undefined, '')).toThrow(/name/);
    function named() {
      return Promise.resolve();
    }
    k.platform.events.subscribe('t', named);
    expect(() => k.platform.events.subscribe('t', named)).toThrow(/already subscribed/);
  });
});
