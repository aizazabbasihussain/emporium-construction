import type { Logger } from 'pino';
import type { Runtime } from './compose.js';

const TICK_MS = 60_000;
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerState {
  lastPurgeAt: number;
}

type Jobs = Pick<Runtime, 'db' | 'platform' | 'notifications' | 'files' | 'quotations' | 'dpr'>;

/**
 * One scheduler tick (spec P1-04 BR-8): deliver due outbox events, deliver due reminders, tell the
 * project managers about missing daily reports from 18:00 Asia/Karachi (P1-15 BR-6; it runs once a
 * day by itself) and, once a day, run the file and notification purges and expire quotations past
 * their validity (P1-08 BR-5). A failing job is logged and does not stop the others.
 */
export async function runSchedulerTick(
  jobs: Jobs,
  state: SchedulerState,
  now: Date,
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  const run = async (name: string, job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (error) {
      logger.error({ err: error, job: name }, 'scheduled job failed');
    }
  };
  await run('events', () => jobs.platform.events.dispatchDue(jobs.db));
  await run('reminders', () => jobs.notifications.tickReminders(jobs.db));
  await run('dpr-missing', () => jobs.db.transaction((tx) => jobs.dpr.notifyMissingDprs(tx, now)));
  if (now.getTime() - state.lastPurgeAt >= PURGE_EVERY_MS) {
    state.lastPurgeAt = now.getTime();
    await run('files-purge', () => jobs.files.purgeExpired(jobs.db));
    await run('notifications-purge', () => jobs.notifications.purgeOld(jobs.db));
    await run('quotations-expire', () =>
      jobs.db.transaction((tx) => jobs.quotations.expireDue(tx)),
    );
  }
}

/** Starts the minute tick; returns a function that stops it. */
export function startScheduler(jobs: Jobs, logger: Pick<Logger, 'error'>): () => void {
  const state: SchedulerState = { lastPurgeAt: 0 };
  let running = false;
  const timer = setInterval(() => {
    // A slow tick must not overlap the next one.
    if (running) return;
    running = true;
    void runSchedulerTick(jobs, state, new Date(), logger).finally(() => {
      running = false;
    });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
