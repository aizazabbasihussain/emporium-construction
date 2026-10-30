import { ConflictError, NotFoundError, RuleViolationError } from '@emporium/domain';

/** A missing record is reported as not found, whoever asks. */
export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** Constitution 5.2: the update matched no row although the record exists, so the version moved on. */
export function assertUpdated<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return row;
}

/** A month has one wage period (unique year and month). */
export function assertMonthFree(existing: unknown): void {
  if (existing !== undefined) {
    throw new ConflictError('period_exists', 'A wage period already exists for this month');
  }
}

/** BR-2: a worker without a pay rate on a worked day cannot be paid. */
export function missingRate(workerName: string, date: string): RuleViolationError {
  return new RuleViolationError(
    'worker_rate_missing',
    `${workerName} has no pay rate in effect on ${date}`,
  );
}

/** BR-11: a period with no lines has nothing to approve. */
export function assertHasLines(count: number): void {
  if (count === 0) {
    throw new RuleViolationError(
      'period_empty',
      'The wage period has no lines; calculate it first',
    );
  }
}

/** BR-11: reopening is blocked once payment (P2-07) has paid any line. */
export function assertNotPaid(paid: boolean): void {
  if (paid) {
    throw new RuleViolationError(
      'period_paid',
      'A line of this period has been paid; it cannot be reopened',
    );
  }
}
