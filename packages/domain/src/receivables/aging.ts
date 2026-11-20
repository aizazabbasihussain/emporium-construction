import { ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';
import { Money } from '../kernel/money.js';

/** H-30: `30,60,90` gives the buckets 0-30, 31-60, 61-90 and 90+. */
export function parseBuckets(text: string): number[] {
  const bounds = text.split(',').map((part) => Number(part.trim()));
  const valid = bounds.every(
    (n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > (bounds[i - 1] as number)),
  );
  if (!valid) {
    throw new ValidationError('aging_buckets_invalid', 'Bucket limits are rising whole days');
  }
  return bounds;
}

/** `current` (not yet due) first, then one label per bucket, the last one open-ended. */
export function bucketLabels(bounds: readonly number[]): string[] {
  const labels = bounds.map((n, i) => `${i === 0 ? 0 : (bounds[i - 1] as number) + 1}-${n}`);
  return ['current', ...labels, `${bounds[bounds.length - 1] as number}+`];
}

/** Days past due on the as-of date; zero or less is "current" (not yet due). */
export function daysPastDue(dueDate: string, asOf: string): number {
  return BusinessDate.parse(asOf).daysSince(BusinessDate.parse(dueDate));
}

/** BR-8: index 0 is current, then one index per bucket, the last is open-ended. */
export function bucketIndex(days: number, bounds: readonly number[]): number {
  if (days <= 0) return 0;
  const at = bounds.findIndex((limit) => days <= limit);
  return at === -1 ? bounds.length + 1 : at + 1;
}

export interface AgingItem {
  key: string;
  dueDate: string;
  outstanding: string;
}

export interface AgingRow {
  key: string;
  buckets: string[];
  total: string;
}

export interface AgingReport {
  labels: string[];
  rows: AgingRow[];
  totals: string[];
  total: string;
}

/** BR-8: items grouped by key (customer or project) into the buckets as of one date. */
export function ageItems(
  items: readonly AgingItem[],
  asOf: string,
  bounds: readonly number[],
): AgingReport {
  const labels = bucketLabels(bounds);
  const rows = new Map<string, Money[]>();
  for (const item of items) {
    const outstanding = Money.of(item.outstanding);
    if (outstanding.isZero() || outstanding.isNegative()) continue;
    const cells = rows.get(item.key) ?? labels.map(() => Money.zero());
    const at = bucketIndex(daysPastDue(item.dueDate, asOf), bounds);
    cells[at] = (cells[at] as Money).add(outstanding);
    rows.set(item.key, cells);
  }
  const sum = (cells: Money[]) => cells.reduce((s, c) => s.add(c), Money.zero());
  const columns = labels.map((_, i) =>
    [...rows.values()].reduce((s, r) => s.add(r[i] as Money), Money.zero()),
  );
  return {
    labels,
    rows: [...rows.entries()].map(([key, cells]) => ({
      key,
      buckets: cells.map((c) => c.toString()),
      total: sum(cells).toString(),
    })),
    totals: columns.map((c) => c.toString()),
    total: sum(columns).toString(),
  };
}
