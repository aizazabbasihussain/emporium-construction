import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSchedulerTick, startScheduler, type SchedulerState } from './scheduler.js';

const makeJobs = (overrides: { failing?: string } = {}) => {
  const calls: string[] = [];
  const job = (name: string) => () => {
    calls.push(name);
    return overrides.failing === name
      ? Promise.reject(new Error(`${name} broke`))
      : Promise.resolve(0);
  };
  const jobs = {
    db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
    platform: { events: { dispatchDue: job('events') } },
    notifications: { tickReminders: job('reminders'), purgeOld: job('notifications-purge') },
    files: { purgeExpired: job('files-purge') },
    quotations: { expireDue: job('quotations-expire') },
  } as unknown as Parameters<typeof runSchedulerTick>[0];
  return { jobs, calls };
};

const logger = () => {
  const errors: unknown[][] = [];
  return { errors, logger: { error: (...args: unknown[]) => void errors.push(args) } as never };
};

describe('runSchedulerTick (BR-8)', () => {
  it('delivers events and reminders every tick and purges once a day', async () => {
    const { jobs, calls } = makeJobs();
    const state: SchedulerState = { lastPurgeAt: 0 };
    const day = 24 * 60 * 60 * 1000;

    await runSchedulerTick(jobs, state, new Date(day), logger().logger);
    expect(calls).toEqual([
      'events',
      'reminders',
      'files-purge',
      'notifications-purge',
      'quotations-expire',
    ]);

    calls.length = 0;
    await runSchedulerTick(jobs, state, new Date(day + 60_000), logger().logger);
    expect(calls).toEqual(['events', 'reminders']);

    calls.length = 0;
    await runSchedulerTick(jobs, state, new Date(2 * day), logger().logger);
    expect(calls).toEqual([
      'events',
      'reminders',
      'files-purge',
      'notifications-purge',
      'quotations-expire',
    ]);
  });

  it('logs a failing job and still runs the others', async () => {
    const { jobs, calls } = makeJobs({ failing: 'events' });
    const { errors, logger: log } = logger();
    await runSchedulerTick(jobs, { lastPurgeAt: 0 }, new Date(Date.now()), log);
    expect(calls).toEqual([
      'events',
      'reminders',
      'files-purge',
      'notifications-purge',
      'quotations-expire',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe('scheduled job failed');
    expect(errors[0]?.[0]).toMatchObject({ job: 'events' });
  });
});

describe('startScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every minute, never overlaps itself and can be stopped', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let started = 0;
    const jobs = {
      db: {},
      platform: {
        events: {
          dispatchDue: () => {
            started += 1;
            return new Promise<number>((resolve) => {
              release = () => resolve(0);
            });
          },
        },
      },
      notifications: {
        tickReminders: () => Promise.resolve(0),
        purgeOld: () => Promise.resolve(0),
      },
      files: { purgeExpired: () => Promise.resolve(0) },
    } as unknown as Parameters<typeof startScheduler>[0];

    const stop = startScheduler(jobs, logger().logger);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000); // the first tick is still running
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(2);

    stop();
    release();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(started).toBe(2);
  });
});
