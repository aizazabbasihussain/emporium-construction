import { ValidationError } from '@emporium/domain';
import type { Platform } from '../../platform/index.js';
import type { Actor, Db } from '../types.js';

export interface Change {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Published to the outbox in the same transaction (constitution 5.9). */
  event?: { type: string; payload: unknown };
}

/** BR-9: every change writes an audit entry and, when it has one, an event. */
export function createRecorder(platform: Platform) {
  return async (tx: Db, actor: Actor, change: Change): Promise<void> => {
    await platform.audit.record(
      {
        actorUserId: actor.userId,
        action: change.action,
        entityType: change.entityType,
        entityId: change.entityId,
        before: change.before,
        after: change.after,
        requestId: actor.requestId,
      },
      tx,
    );
    if (change.event !== undefined) await platform.events.publish(change.event, tx);
  };
}

export type Recorder = ReturnType<typeof createRecorder>;

/** Empty text becomes null; other text is trimmed. */
export const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export function requiredText(value: string | null | undefined, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new ValidationError(`${field}_required`, `${field} is required`);
  return text;
}

/** Applies a normalizer to optional text; empty stays null. */
export const normalizedOrNull = (
  value: string | null | undefined,
  normalize: (text: string) => string,
): string | null => {
  const text = textOrNull(value);
  return text === null ? null : normalize(text);
};

export function pageOf<T>(
  rows: T[],
  total: number,
  page: { limit: number; offset: number },
): { items: T[]; total: number; limit: number; offset: number } {
  return { items: rows, total, limit: page.limit, offset: page.offset };
}

export interface ListQuery {
  q?: string | undefined;
  sort?: string | undefined;
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * Search, sort and page a small reference list in memory (units, categories, cost codes, locations,
 * registrations): these lists stay far below a few thousand rows. `sorters` names the sortable
 * fields; an unknown `sort` keeps the natural order.
 */
export function paginateList<T>(
  items: readonly T[],
  query: ListQuery,
  searchable: (item: T) => readonly (string | null)[],
  sorters: Record<string, (item: T) => string>,
): { items: T[]; total: number; limit: number; offset: number } {
  const needle = query.q?.trim().toLowerCase() ?? '';
  const matching =
    needle === ''
      ? [...items]
      : items.filter((item) =>
          searchable(item).some((field) => field?.toLowerCase().includes(needle) === true),
        );
  const sorter = query.sort === undefined ? undefined : sorters[query.sort];
  if (sorter !== undefined) {
    const sign = query.direction === 'desc' ? -1 : 1;
    matching.sort((a, b) => sign * sorter(a).localeCompare(sorter(b)));
  }
  return pageOf(matching.slice(query.offset, query.offset + query.limit), matching.length, query);
}
