import type { Retryable } from './queue.js';

/** Spec P1-20: rules of the photo queue. */

export type UploadStatus = 'pending' | 'uploaded' | 'failed';

export interface PhotoRecord extends Retryable<UploadStatus> {
  id: string;
  draftKey: string;
  name: string;
  compressed: boolean;
  /** Hex digest of the stored bytes; equal photos of one draft are queued once. */
  checksum: string;
  attachmentId: string | null;
  createdAt: number;
}

/**
 * BR-5: photos due for upload now, oldest first. A photo waits until its parent record exists on
 * the server (`parents` maps a draft key to the created record id) and until its own backoff time.
 */
export function uploadable<T extends PhotoRecord>(
  photos: readonly T[],
  parents: ReadonlyMap<string, string>,
  now: number,
): T[] {
  return photos
    .filter((p) => p.status === 'pending' && p.nextAttemptAt <= now && parents.has(p.draftKey))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** True when a photo with the same checksum is already queued for the draft. */
export const isDuplicatePhoto = (
  photos: readonly PhotoRecord[],
  draftKey: string,
  checksum: string,
): boolean => photos.some((p) => p.draftKey === draftKey && p.checksum === checksum);
