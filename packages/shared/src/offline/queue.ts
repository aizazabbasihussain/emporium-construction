/**
 * Spec P1-20: the pure rules of the offline retry queue. Nothing here touches the browser; the web
 * app stores the items and calls these functions to decide what happens next.
 */

import type { DraftFormType } from './drafts.js';

/** Waits after the 1st, 2nd, 3rd and 4th failed attempt (BR-3). */
export const backoffSteps = [5_000, 15_000, 60_000, 300_000] as const;
/** Every attempt after those waits this long (BR-3). */
export const steadyBackoff = 900_000;

/** Milliseconds to wait after the given number of failed attempts (1 or more). */
export function backoffDelay(failedAttempts: number): number {
  return backoffSteps[Math.max(failedAttempts, 1) - 1] ?? steadyBackoff;
}

export type QueueStatus = 'pending' | 'sent' | 'failed';

/** Fields every retryable job carries: queued requests and photo uploads. */
export interface Retryable<S extends string = string> {
  status: S;
  attempts: number;
  /** Epoch milliseconds before which the job is not tried again. */
  nextAttemptAt: number;
  lastError: string | null;
}

export interface QueueSource {
  formType: DraftFormType;
  /** The draft slot of the form, where the raw input goes back to on edit-and-resend. */
  draftKey: string;
  /** The screen that holds the form. */
  path: string;
  /** The raw form input as typed. */
  payload: unknown;
}

export interface QueueItem extends Retryable<QueueStatus> {
  id: string;
  idempotencyKey: string;
  method: string;
  url: string;
  body: unknown;
  /** The signed-in user who queued it; another user's items are never sent. */
  userId: string;
  /**
   * The form this request came from, so a failed item can be put back into the form for
   * edit-and-resend. Its photos are stored under the item's own id.
   */
  source: QueueSource | null;
  /** Id of the record the server created, once sent. */
  resultId: string | null;
  createdAt: number;
}

/** What one attempt to send a job came back with. */
export type Outcome =
  | { kind: 'ok'; resultId?: string | null }
  | { kind: 'network' }
  | { kind: 'http'; status: number; message: string };

/** Server answers that retrying cannot fix (BR-4). */
export const stopStatuses: readonly number[] = [409, 422];

/** Sign-in has lapsed; the whole queue waits for the user (BR-4). */
export const unauthorizedStatus = 401;

export interface Applied<T> {
  item: T;
  /** True when the whole queue must stop until the user signs in. */
  pauseQueue: boolean;
}

/**
 * The next state of a job after an attempt. Success marks it done; 409 and 422 mark it failed with
 * the server's reason; 401 keeps it pending and pauses the queue without counting an attempt; any
 * other failure keeps it pending and schedules the next try by the backoff schedule.
 */
export function applyOutcome<T extends Retryable>(
  item: T,
  outcome: Outcome,
  now: number,
  doneStatus: T['status'],
  failedStatus: T['status'],
): Applied<T> {
  if (outcome.kind === 'ok') {
    const next = { ...item, status: doneStatus, lastError: null };
    const resultId = outcome.resultId ?? null;
    return { item: resultId === null ? next : { ...next, resultId }, pauseQueue: false };
  }
  if (outcome.kind === 'http' && outcome.status === unauthorizedStatus) {
    return { item: { ...item, lastError: outcome.message }, pauseQueue: true };
  }
  const attempts = item.attempts + 1;
  if (outcome.kind === 'http' && stopStatuses.includes(outcome.status)) {
    return {
      item: { ...item, attempts, status: failedStatus, lastError: outcome.message },
      pauseQueue: false,
    };
  }
  const lastError = outcome.kind === 'http' ? outcome.message : 'offline';
  return {
    item: { ...item, attempts, lastError, nextAttemptAt: now + backoffDelay(attempts) },
    pauseQueue: false,
  };
}

/** Pending items of this user that are due, oldest first. A paused queue has none. */
export function dueItems(
  items: readonly QueueItem[],
  now: number,
  userId: string,
  paused: boolean,
): QueueItem[] {
  if (paused) return [];
  return items
    .filter((i) => i.status === 'pending' && i.userId === userId && i.nextAttemptAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** When the earliest pending item of this user becomes due; null when nothing is waiting. */
export function nextDueAt(items: readonly QueueItem[], userId: string): number | null {
  const times = items
    .filter((i) => i.status === 'pending' && i.userId === userId)
    .map((i) => i.nextAttemptAt);
  return times.length === 0 ? null : Math.min(...times);
}

/** Adds an item unless one with the same idempotency key is queued already (dedupe by key). */
export function enqueueItem(
  items: readonly QueueItem[],
  candidate: QueueItem,
): { items: QueueItem[]; added: boolean } {
  if (items.some((i) => i.idempotencyKey === candidate.idempotencyKey)) {
    return { items: [...items], added: false };
  }
  return { items: [...items, candidate], added: true };
}

/** Unsent means still waiting or failed: what the status bar counts and the list shows. */
export const isUnsent = (item: { status: string }): boolean => item.status !== 'sent';
