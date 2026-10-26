import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import type { CostStatus, ProjectStatus } from './status.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const costObjectTypes = ['project', 'work_order', 'overhead'] as const;
export type CostObjectType = (typeof costObjectTypes)[number];

/** BR-5: the one source document type that may carry a negative amount (besides a reversal). */
export const SALVAGE_DOC_TYPE = 'salvage';

/** Constitution 5.4: money is a decimal string with at most two decimals, never a float. */
export function normalizeAmount(text: string): string {
  const trimmed = text.trim();
  if (!/^-?\d{1,16}(\.\d{1,2})?$/.test(trimmed)) {
    throw new ValidationError('amount_invalid', 'Enter an amount with at most two decimals');
  }
  return new Dec(trimmed).toFixed(2);
}

/** BR-5: a negative amount is allowed only for salvage. */
export function assertAmountAllowed(amount: string, sourceDocType: string): void {
  if (new Dec(amount).isNegative() && sourceDocType !== SALVAGE_DOC_TYPE) {
    throw new RuleViolationError(
      'amount_negative',
      'Only a salvage credit can have a negative amount',
    );
  }
}

/**
 * BR-5 and BR-11: the cost object must be allowed and, for a project, open for costs. Overhead has
 * no object id; a work order is refused until Phase 3 switches it on.
 */
export function assertCostObjectOpen(object: {
  type: CostObjectType;
  id: string | null;
  workOrdersEnabled: boolean;
  projectStatus: ProjectStatus | null;
}): void {
  if (object.type === 'work_order' && !object.workOrdersEnabled) {
    throw new RuleViolationError(
      'work_order_disabled',
      'Work orders cannot carry costs before Phase 3',
    );
  }
  if (object.type === 'overhead') {
    if (object.id !== null) {
      throw new ValidationError('overhead_has_no_id', 'An overhead entry has no cost object id');
    }
    return;
  }
  if (object.id === null) {
    throw new ValidationError('cost_object_required', 'Name the project or work order');
  }
  if (object.type === 'project') {
    if (object.projectStatus === null) {
      throw new RuleViolationError('cost_object_not_found', 'The project does not exist');
    }
    if (object.projectStatus !== 'planning' && object.projectStatus !== 'active') {
      throw new RuleViolationError(
        'cost_object_not_open',
        'Costs can be posted only to a planning or active project',
      );
    }
  }
}

/** BR-6: entries of one source line form a chain; the key ties its rows together. */
export function chainKey(
  sourceModule: string,
  sourceDocType: string,
  sourceDocId: string,
  sourceLineId: string | null,
): string {
  return [sourceModule, sourceDocType, sourceDocId, sourceLineId ?? ''].join('|');
}

export interface ChainRow {
  seq: number;
  chain: string;
  costCodeId: string;
  amount: string;
  status: CostStatus;
}

export interface StatusTotals {
  committed: string;
  approved: string;
  posted: string;
}

/**
 * BR-6 and BR-7: the current row of each chain (rows that share a source line) is its latest; a
 * chain whose latest row is reversed counts for nothing. Totals are kept per status. This is the
 * reference model the summary view follows.
 */
export function summarizeChains(rows: readonly ChainRow[]): StatusTotals {
  const latest = new Map<string, ChainRow>();
  for (const row of rows) {
    const seen = latest.get(row.chain);
    if (seen === undefined || seen.seq < row.seq) latest.set(row.chain, row);
  }
  const totals = { committed: new Dec(0), approved: new Dec(0), posted: new Dec(0) };
  for (const row of latest.values()) {
    if (row.status !== 'reversed') totals[row.status] = totals[row.status].plus(row.amount);
  }
  return {
    committed: totals.committed.toFixed(2),
    approved: totals.approved.toFixed(2),
    posted: totals.posted.toFixed(2),
  };
}

/** Adds up the rows of the summary view (one per cost code). */
export function addTotals(parts: readonly StatusTotals[]): StatusTotals {
  const sum = (pick: (t: StatusTotals) => string) =>
    parts.reduce((acc, part) => acc.plus(pick(part)), new Dec(0)).toFixed(2);
  return {
    committed: sum((t) => t.committed),
    approved: sum((t) => t.approved),
    posted: sum((t) => t.posted),
  };
}

/** Adds money strings exactly, to two decimals. */
export function sumAmounts(values: readonly string[]): string {
  return values.reduce((acc, value) => acc.plus(value), new Dec(0)).toFixed(2);
}
