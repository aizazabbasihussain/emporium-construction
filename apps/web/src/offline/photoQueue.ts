import { applyOutcome, isDuplicatePhoto, uploadable, type Outcome } from '@emporium/shared';
import { compressImage, browserDeps, type CompressDeps } from '../files/compress';
import type { OfflineDb, PhotoRow } from './db';
import { outcomeOfError } from './submitQueue';

/** Uploads one stored photo to its parent record; the real one calls the files API. */
export type PhotoUploader = (row: PhotoRow, parentId: string) => Promise<{ id: string }>;

export interface PhotoQueueDeps {
  db: OfflineDb;
  upload: PhotoUploader;
  compression?: CompressDeps;
  now?: () => number;
  newId?: () => string;
}

export interface PhotoQueue {
  /** Compresses the photo (BR-5) and stores it for the draft; false when it was added before. */
  add(draftKey: string, file: File): Promise<boolean>;
  listFor(draftKey: string): Promise<PhotoRow[]>;
  list(): Promise<PhotoRow[]>;
  remove(id: string): Promise<void>;
  /** Moves the photos of one group to another: a form's photos follow it into the queue and back. */
  rekey(from: string, to: string): Promise<void>;
  /** Removes the photos of a group that have reached the server; true when none are left. */
  settle(draftKey: string): Promise<boolean>;
  /** Makes every waiting photo due now. */
  retryNow(): Promise<void>;
  /**
   * Uploads due photos whose parent exists, one by one. A failure of one photo only schedules that
   * photo again; the others still go. Stops early when sign-in has lapsed.
   */
  run(parents: ReadonlyMap<string, string>): Promise<{ uploaded: number; paused: boolean }>;
}

async function checksumOf(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createPhotoQueue(deps: PhotoQueueDeps): PhotoQueue {
  const { db, upload } = deps;
  const compression = deps.compression ?? browserDeps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const all = () => db.photos.all();

  return {
    async add(draftKey, file) {
      const compressed = await compressImage(file, compression);
      const checksum = await checksumOf(compressed);
      if (isDuplicatePhoto(await all(), draftKey, checksum)) return false;
      const row: PhotoRow = {
        id: newId(),
        draftKey,
        blob: compressed,
        name: compressed.name,
        compressed: compressed !== file,
        checksum,
        attachmentId: null,
        createdAt: now(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      };
      await db.photos.put(row);
      return true;
    },
    async listFor(draftKey) {
      return (await all())
        .filter((p) => p.draftKey === draftKey)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    list: all,
    remove: (id) => db.photos.delete(id),
    async rekey(from, to) {
      for (const photo of await all()) {
        if (photo.draftKey === from) await db.photos.put({ ...photo, draftKey: to });
      }
    },
    async settle(draftKey) {
      const mine = (await all()).filter((p) => p.draftKey === draftKey);
      for (const photo of mine.filter((p) => p.status === 'uploaded')) {
        await db.photos.delete(photo.id);
      }
      return mine.every((p) => p.status === 'uploaded');
    },
    async retryNow() {
      for (const photo of await all()) {
        if (photo.status === 'pending') await db.photos.put({ ...photo, nextAttemptAt: 0 });
      }
    },
    async run(parents) {
      let uploaded = 0;
      for (const due of uploadable(await all(), parents, now())) {
        let outcome: Outcome;
        let attachmentId: string | null = null;
        try {
          const result = await upload(due, parents.get(due.draftKey) as string);
          attachmentId = result.id;
          outcome = { kind: 'ok' };
        } catch (cause) {
          outcome = outcomeOfError(cause);
        }
        const applied = applyOutcome(due, outcome, now(), 'uploaded', 'failed');
        await db.photos.put({
          ...applied.item,
          attachmentId: attachmentId ?? applied.item.attachmentId,
        });
        if (outcome.kind === 'ok') uploaded += 1;
        if (applied.pauseQueue) return { uploaded, paused: true };
      }
      return { uploaded, paused: false };
    },
  };
}
