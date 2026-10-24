import { NotFoundError, ValidationError } from '@emporium/domain';
import { MAX_DISPATCH_ATTEMPTS, retryDelayMs, type Clock } from '@emporium/domain/kernel';
import {
  consume,
  findDue,
  findEvent,
  insertEvent,
  listFailed,
  markDispatched,
  recordAttempt,
  requeueFailed,
  type OutboxRow,
} from '../repo/outbox.repo.js';
import type { Db } from '../types.js';

export interface DomainEvent {
  type: string;
  payload: unknown;
}

export interface DeliveredEvent extends DomainEvent {
  id: string;
}

/** Handlers must be idempotent; they run in the same transaction as their consumption record. */
export type EventHandler = (event: DeliveredEvent, tx: Db) => Promise<void>;

export interface DispatchSummary {
  dispatched: number;
  retrying: number;
  failed: number;
}

export interface EventsService {
  /** Writes the event to the outbox inside the caller's transaction (constitution 5.9). */
  publish(event: DomainEvent, tx: Db): Promise<string>;
  subscribe(type: string, handler: EventHandler, name?: string): void;
  /** Delivers due events to every subscriber at least once (BR-6). */
  dispatchDue(db: Db, limit?: number): Promise<DispatchSummary>;
  listFailed(db: Db): Promise<OutboxRow[]>;
  retryFailed(eventId: string, tx: Db): Promise<OutboxRow>;
}

interface Subscriber {
  name: string;
  handler: EventHandler;
}

export function createEventsService(deps: { clock: Clock; newId: () => string }): EventsService {
  const subscribers = new Map<string, Subscriber[]>();

  return {
    async publish(event, tx) {
      const id = deps.newId();
      await insertEvent(tx, { id, ...event, occurredAt: deps.clock.now() });
      return id;
    },

    subscribe(type, handler, name = handler.name) {
      if (name === '') {
        throw new ValidationError('handler_name_required', 'An event handler needs a name');
      }
      const list = subscribers.get(type) ?? [];
      if (list.some((s) => s.name === name)) {
        throw new ValidationError(
          'handler_exists',
          `Handler ${name} is already subscribed to ${type}`,
        );
      }
      subscribers.set(type, [...list, { name, handler }]);
    },

    async dispatchDue(db, limit = 50) {
      const summary: DispatchSummary = { dispatched: 0, retrying: 0, failed: 0 };
      for (const event of await findDue(db, deps.clock.now(), limit)) {
        const delivered: DeliveredEvent = {
          id: event.id,
          type: event.type,
          payload: event.payload,
        };
        const errors: string[] = [];
        for (const { name, handler } of subscribers.get(event.type) ?? []) {
          try {
            await db.transaction(async (tx) => {
              if (await consume(tx, event.id, name)) await handler(delivered, tx);
            });
          } catch (error) {
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const now = deps.clock.now();
        if (errors.length === 0) {
          await markDispatched(db, event.id, now);
          summary.dispatched += 1;
          continue;
        }
        const attempts = event.attempts + 1;
        const exhausted = attempts >= MAX_DISPATCH_ATTEMPTS;
        await recordAttempt(db, event.id, {
          attempts,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
          error: errors.join('; '),
          failedAt: exhausted ? now : null,
        });
        if (exhausted) summary.failed += 1;
        else summary.retrying += 1;
      }
      return summary;
    },

    listFailed: (db) => listFailed(db),

    async retryFailed(eventId, tx) {
      const row = await requeueFailed(tx, eventId, deps.clock.now());
      if (row) return row;
      if (!(await findEvent(tx, eventId)))
        throw new NotFoundError('event_not_found', 'Event not found');
      throw new ValidationError('event_not_failed', 'Only failed events can be retried');
    },
  };
}
