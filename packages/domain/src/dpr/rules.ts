import { RuleViolationError, ValidationError } from '../errors.js';

export const MIN_WORK_DONE_CHARS = 10;
export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** BR-6: missing reports are notified at 18:00 Asia/Karachi. */
export const REPORT_DEADLINE_HOUR = 18;

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** BR-3: the work done text needs at least 10 characters once trimmed. */
export function assertWorkDone(text: string): void {
  if (text.trim().length < MIN_WORK_DONE_CHARS) {
    throw new ValidationError(
      'work_done_short',
      `Describe the work done in at least ${MIN_WORK_DONE_CHARS} characters`,
    );
  }
}

/** BR-3: at least one photo, unless the setting turns the requirement off. */
export function assertPhotosForSubmit(photoCount: number, required: boolean): void {
  if (required && photoCount < 1) {
    throw new RuleViolationError('photo_required', 'Attach at least one photo before submitting');
  }
}

/** BR-7: no more than 20 photos on a report; `photoCount` is how many it holds already. */
export function assertPhotoCapacity(photoCount: number): void {
  if (photoCount >= MAX_PHOTOS) {
    throw new RuleViolationError('photo_limit', `A report can have at most ${MAX_PHOTOS} photos`);
  }
}

/** BR-7: each photo is at most 10 MB after compression. */
export function isPhotoSizeAllowed(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_PHOTO_BYTES;
}

export interface TaskUpdateInput {
  taskId: string;
  percentComplete: number;
  note?: string | null | undefined;
}

export interface TaskUpdate {
  taskId: string;
  percentComplete: number;
  note: string | null;
}

/**
 * BR-4: percent complete is a whole number from 0 to 100 and may not go below the task's current
 * percent unless the update carries a note.
 */
export function checkTaskUpdate(input: TaskUpdateInput, currentPercent: number): TaskUpdate {
  const percent = input.percentComplete;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new ValidationError(
      'task_percent_invalid',
      'Percent complete is a whole number 0 to 100',
    );
  }
  const note = input.note?.trim() ?? '';
  if (percent < currentPercent && note === '') {
    throw new RuleViolationError(
      'task_percent_decrease',
      'Lowering the percent complete of a task needs a note',
    );
  }
  return { taskId: input.taskId, percentComplete: percent, note: note === '' ? null : note };
}

export interface ManpowerEntry {
  trade: string;
  count: number;
}

/** The manual manpower list: every trade is named and counted with a whole number. */
export function normalizeManpower(entries: readonly ManpowerEntry[]): ManpowerEntry[] {
  return entries.map((entry) => {
    const trade = entry.trade.trim();
    if (trade === '' || !Number.isInteger(entry.count) || entry.count < 0) {
      throw new ValidationError('manpower_invalid', 'Each trade needs a name and a count');
    }
    return { trade, count: entry.count };
  });
}

/** BR-6: the setting `site_holidays` is a comma-separated list of yyyy-mm-dd dates. */
export function parseSiteHolidays(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{4}-\d{2}-\d{2}$/.test(part));
}

export function isSiteHoliday(date: string, holidaysText: string): boolean {
  return parseSiteHolidays(holidaysText).includes(date);
}

/** BR-6: true from 18:00 Asia/Karachi on, for the rest of that business day. */
export function isPastDeadline(now: Date): boolean {
  const msIntoDay = (((now.getTime() + KARACHI_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return msIntoDay >= REPORT_DEADLINE_HOUR * HOUR_MS;
}

export interface SupervisedProject {
  projectId: string;
  supervisorIds: readonly string[];
}

/**
 * BR-6: projects with an assigned supervisor and no filed report for the date. A project with no
 * supervisor is not expected to report.
 */
export function selectMissing<T extends SupervisedProject>(
  projects: readonly T[],
  filedProjectIds: ReadonlySet<string>,
): T[] {
  return projects.filter(
    (project) => project.supervisorIds.length > 0 && !filedProjectIds.has(project.projectId),
  );
}
