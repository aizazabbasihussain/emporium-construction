import {
  applyOutcome,
  dueItems,
  enqueueItem,
  nextDueAt,
  type Outcome,
  type QueueItem,
  type QueueSource,
} from '@emporium/shared';
import { ApiError } from '../admin/api';
import type { OfflineDb } from './db';

/** What the queue needs to send one request; the real one calls the API with the item's key. */
export type Sender = (item: QueueItem) => Promise<{ id?: string } | null | undefined>;

export interface EnqueueInput {
  method: string;
  url: string;
  body: unknown;
  userId: string;
  source?: QueueSource;
  /** Reuse a key to make queuing the same action twice a no-op. */
  idempotencyKey?: string;
}

export interface SubmitQueueDeps {
  db: OfflineDb;
  send: Sender;
  now?: () => number;
  newId?: () => string;
  /** Called after an item reaches the server, before the next one is tried. */
  onSent?: (item: QueueItem) => Promise<void> | void;
}

export interface SubmitQueue {
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  /** Sends every due item of the user in order; returns how many reached the server. */
  run(userId: string): Promise<number>;
  list(userId: string): Promise<QueueItem[]>;
  /** Removes an item: a failed one the user gave up on, or a delivered one nothing depends on. */
  discard(id: string): Promise<void>;
  /** Makes every waiting item due now (for example when the browser comes back online). */
  retryNow(userId: string): Promise<void>;
  readonly paused: boolean;
  /** Stops sending until `resume` (sign-in lapsed). */
  pause(): void;
  /** Sign-in is back: start sending again. */
  resume(): void;
  /** Epoch ms of the next scheduled attempt, or null. */
  nextAttempt(userId: string): Promise<number | null>;
}

/** Turns what a failed call threw into the outcome the pure rules understand. */
export function outcomeOfError(cause: unknown): Outcome {
  return cause instanceof ApiError
    ? { kind: 'http', status: cause.status, message: cause.message }
    : { kind: 'network' };
}

/** BR-3 and BR-4: the retry queue over IndexedDB. Rules live in `@emporium/shared`. */
export function createSubmitQueue(deps: SubmitQueueDeps): SubmitQueue {
  const { db, send } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let paused = false;
  let running: Promise<number> | null = null;

  const all = () => db.queue.all();

  async function runOnce(userId: string): Promise<number> {
    let delivered = 0;
    // Items are re-read each round: a send may enqueue nothing, but the user may discard meanwhile.
    for (const due of dueItems(await all(), now(), userId, paused)) {
      if (paused) break;
      const current = await db.queue.get(due.id);
      if (current?.status !== 'pending') continue;
      let outcome: Outcome;
      try {
        const result = await send(current);
        outcome = { kind: 'ok', resultId: result?.id ?? null };
      } catch (cause) {
        outcome = outcomeOfError(cause);
      }
      const applied = applyOutcome(current, outcome, now(), 'sent', 'failed');
      await db.queue.put(applied.item);
      if (applied.pauseQueue) paused = true;
      if (outcome.kind === 'ok') {
        delivered += 1;
        await deps.onSent?.(applied.item);
      }
    }
    return delivered;
  }

  return {
    async enqueue(input) {
      const at = now();
      const candidate: QueueItem = {
        id: newId(),
        idempotencyKey: input.idempotencyKey ?? newId(),
        method: input.method,
        url: input.url,
        body: input.body,
        userId: input.userId,
        source: input.source ?? null,
        resultId: null,
        createdAt: at,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
      };
      const existing = await all();
      if (!enqueueItem(existing, candidate).added) {
        return existing.find((i) => i.idempotencyKey === candidate.idempotencyKey) ?? candidate;
      }
      await db.queue.put(candidate);
      return candidate;
    },
    // Two overlapping triggers (online event and timer) share one pass, never two.
    run(userId) {
      running ??= runOnce(userId).finally(() => {
        running = null;
      });
      return running;
    },
    async list(userId) {
      return (await all())
        .filter((i) => i.userId === userId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    discard: (id) => db.queue.delete(id),
    async retryNow(userId) {
      for (const item of await all()) {
        if (item.userId === userId && item.status === 'pending') {
          await db.queue.put({ ...item, nextAttemptAt: now() });
        }
      }
    },
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    nextAttempt: async (userId) => nextDueAt(await all(), userId),
  };
}
