import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const taskStatuses = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

/** BR-10: percent complete is a whole number from 0 to 100, and a done task is at 100. */
export function assertTaskProgress(status: TaskStatus, percent: number): void {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new ValidationError('percent_invalid', 'Percent complete must be from 0 to 100');
  }
  if (status === 'done' && percent !== 100) {
    throw new ValidationError('done_needs_100', 'A done task must be 100 percent complete');
  }
}

/** BR-10: the project's progress is the plain average of its tasks, to two decimals. */
export function projectProgress(percents: readonly number[]): string {
  if (percents.length === 0) return '0.00';
  return percents
    .reduce((acc, percent) => acc.plus(percent), new Dec(0))
    .div(percents.length)
    .toFixed(2);
}
