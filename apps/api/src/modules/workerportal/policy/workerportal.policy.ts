import { ConflictError, DomainError, ValidationError } from '@emporium/domain';
import { WORKER_ROLE } from '@emporium/shared';

/** BR-2: a user with no link has no worker to show. */
export function assertLinked<T>(link: T | undefined): T {
  if (link === undefined) {
    throw new DomainError('forbidden', 'no_worker_link', 'This login is not linked to a worker');
  }
  return link;
}

/** BR-4: access ends at the end of the left date, so on the left date itself it still works. */
export const hasPortalAccess = (leftOn: string | null, today: string): boolean =>
  leftOn === null || today <= leftOn;

export function assertPortalAccess(leftOn: string | null, today: string): void {
  if (!hasPortalAccess(leftOn, today)) {
    throw new DomainError('forbidden', 'worker_left', 'This worker has left the company');
  }
}

/** BR-1: a login that holds any role besides `worker` is linked only when the admin confirms. */
export function assertLinkableRoles(roles: readonly string[], confirmed: boolean): void {
  const onlyWorker = roles.length === 1 && roles[0] === WORKER_ROLE;
  if (!onlyWorker && !confirmed) {
    throw new ValidationError(
      'user_has_other_roles',
      'The user does not hold only the worker role; confirm to link anyway',
      { roles: [...roles] },
    );
  }
}

/** A user belongs to one worker: linking them to a second worker is refused. */
export function assertUserFree(linkedWorkerId: string | undefined, workerId: string): void {
  if (linkedWorkerId !== undefined && linkedWorkerId !== workerId) {
    throw new ConflictError('user_already_linked', 'This user is already linked to another worker');
  }
}

export interface MonthRange {
  year: number;
  month: number;
  /** `yyyy-mm`. */
  key: string;
  from: string;
  to: string;
}

/** The `month` query value `yyyy-mm` as the first and last day of that month. */
export function parseMonth(text: string): MonthRange {
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (match === null || year < 2000 || year > 2100 || month < 1 || month > 12) {
    throw new ValidationError('invalid_month', 'The month must look like 2026-10');
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const key = `${match[1]}-${match[2]}`;
  return { year, month, key, from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
}

/** The months from `end` back, newest first: `count` of them as `{ year, month }`. */
export function monthsBack(end: { year: number; month: number }, count: number) {
  const result: { year: number; month: number }[] = [];
  let { year, month } = end;
  for (let i = 0; i < count; i += 1) {
    result.push({ year, month });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return result;
}
