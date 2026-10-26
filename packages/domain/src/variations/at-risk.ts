import Decimal from 'decimal.js';
import { chainKey } from '../costing/ledger.js';
import { isOpenStatus } from './status.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** A cost ledger row as the projects module lists it (newest first). */
export interface LedgerRow {
  sourceModule: string;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId: string | null;
  costCodeId: string;
  amount: string;
  status: string;
  entryDate: string;
}

export interface AtRiskLine {
  costCodeId: string;
  amount: string;
}

export interface AtRisk {
  total: string;
  byCostCode: AtRiskLine[];
}

/**
 * BR-8: costs posted to the project on or after the date the variation was discovered and before
 * it is approved are at risk. Only costs whose cost code matches a variation line count, and only
 * `approved` and `posted` ones. The current row of each chain is the newest (constitution 6), so
 * `rows` must be newest first; a chain whose current row is reversed or only committed counts for
 * nothing. A variation that is already decided has nothing at risk.
 */
export function atRisk(
  variation: { status: string; discoveredOn: string; costCodeIds: readonly string[] },
  rows: readonly LedgerRow[],
): AtRisk {
  if (!isOpenStatus(variation.status)) return { total: '0.00', byCostCode: [] };
  const seen = new Set<string>();
  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    const key = chainKey(row.sourceModule, row.sourceDocType, row.sourceDocId, row.sourceLineId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      (row.status === 'approved' || row.status === 'posted') &&
      variation.costCodeIds.includes(row.costCodeId) &&
      row.entryDate >= variation.discoveredOn
    ) {
      totals.set(row.costCodeId, (totals.get(row.costCodeId) ?? new Dec(0)).plus(row.amount));
    }
  }
  const byCostCode = [...totals.entries()]
    .map(([costCodeId, amount]) => ({ costCodeId, amount: amount.toFixed(2) }))
    .sort((a, b) => a.costCodeId.localeCompare(b.costCodeId));
  const total = byCostCode.reduce((sum, line) => sum.plus(line.amount), new Dec(0)).toFixed(2);
  return { total, byCostCode };
}
