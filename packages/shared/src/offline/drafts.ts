/** Spec P1-20: rules for the drafts kept on the device. */

export const draftFormTypes = ['dpr', 'attendance', 'expense'] as const;
export type DraftFormType = (typeof draftFormTypes)[number];

/** BR-2: a form is saved this long after the last change. */
export const autosaveDelayMs = 500;
/** BR-6: a draft not touched for this long is flagged. */
export const staleAfterDays = 30;
/** BR-6: below this much free storage the user is warned. */
export const lowStorageBytes = 50 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Draft<P = unknown> {
  key: string;
  formType: DraftFormType;
  payload: P;
  updatedAt: number;
  userId: string;
}

/** The storage key of a draft: one per form type and scope (for example a team and date). */
export const draftKey = (formType: DraftFormType, scope: string): string => `${formType}:${scope}`;

export const isStaleDraft = (draft: Pick<Draft, 'updatedAt'>, now: number): boolean =>
  now - draft.updatedAt > staleAfterDays * DAY_MS;

/** Free space from the browser's storage estimate; an unknown estimate counts as plenty. */
export function isStorageLow(estimate: { quota?: number; usage?: number } | null): boolean {
  if (estimate?.quota === undefined || estimate.usage === undefined) return false;
  return estimate.quota - estimate.usage < lowStorageBytes;
}

/**
 * BR-8: a draft for a date that already has a submitted report on the server must not overwrite
 * it. `existing` is what the server has for the same project; other dates are fine.
 */
export function submittedConflict(
  reportDate: string,
  existing: readonly { reportDate: string; status: string }[],
): boolean {
  return existing.some((r) => r.reportDate === reportDate && r.status !== 'draft');
}
