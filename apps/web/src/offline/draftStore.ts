import { isStaleDraft, type Draft, type DraftFormType } from '@emporium/shared';
import type { OfflineDb } from './db';

/** Spec P1-20 BR-2: drafts of raw form input, kept per signed-in user. */
export interface DraftStore {
  save<P>(key: string, formType: DraftFormType, payload: P, userId: string): Promise<Draft<P>>;
  /** The user's own draft; another user's draft under the same key is invisible. */
  get<P>(key: string, userId: string): Promise<Draft<P> | undefined>;
  remove(key: string, userId: string): Promise<void>;
  list(userId: string): Promise<Draft[]>;
  /** BR-6: the user's drafts untouched for more than 30 days. */
  stale(userId: string): Promise<Draft[]>;
  /** Deletes all of the user's drafts (logout on a shared device, after confirmation). */
  clear(userId: string): Promise<void>;
}

export function createDraftStore(db: OfflineDb, now: () => number = Date.now): DraftStore {
  const own = async (userId: string) => (await db.drafts.all()).filter((d) => d.userId === userId);
  return {
    async save<P>(key: string, formType: DraftFormType, payload: P, userId: string) {
      const draft: Draft<P> = { key, formType, payload, updatedAt: now(), userId };
      await db.drafts.put(draft);
      return draft;
    },
    async get<P>(key: string, userId: string) {
      return (await db.drafts.get([userId, key])) as Draft<P> | undefined;
    },
    async remove(key, userId) {
      await db.drafts.delete([userId, key]);
    },
    list: own,
    async stale(userId) {
      const at = now();
      return (await own(userId)).filter((d) => isStaleDraft(d, at));
    },
    async clear(userId) {
      for (const draft of await own(userId)) await db.drafts.delete([userId, draft.key]);
    },
  };
}
