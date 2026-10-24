import { createTestDb, type SqlDb } from '@emporium/db';
import type { Clock } from '@emporium/domain/kernel';
import { createPlatform, type Platform } from './index.js';
import type { Principal } from './types.js';

export interface MutableClock extends Clock {
  set(iso: string): void;
}

export function mutableClock(iso: string): MutableClock {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set(next) {
      current = new Date(next);
    },
  };
}

/** Deterministic, sortable UUIDs for tests. */
export function sequentialIds(): () => string {
  let n = 0;
  return () => `018f0000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
}

export interface Kernel {
  db: SqlDb;
  clock: MutableClock;
  platform: Platform;
}

export async function createKernel(iso = '2026-10-24T10:00:00Z'): Promise<Kernel> {
  const db = await createTestDb();
  const clock = mutableClock(iso);
  return { db, clock, platform: createPlatform({ clock, newId: sequentialIds() }) };
}

export const ADMIN_ID = '018f1111-0000-7000-8000-000000000001';
export const OTHER_ID = '018f1111-0000-7000-8000-000000000002';

export const principal = (userId: string, ...permissions: string[]): Principal => ({
  userId,
  permissions: new Set(permissions),
});
