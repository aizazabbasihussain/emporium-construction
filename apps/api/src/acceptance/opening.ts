import type { SqlDb } from '@emporium/db';
import { compareOpening, parseControlSheet, type OpeningDifference } from './cutover.js';

/**
 * Totals the system holds after the opening load, keyed like the control sheet (P2-10 BR-1).
 * Only cash and bank account balances can be loaded today; the other categories of H-13 have no
 * importer yet, so they have no key here and show up as "not loaded" when the sheet lists them.
 */
export async function loadedOpeningTotals(db: SqlDb): Promise<Record<string, string>> {
  const rows = await db.query<{ kind: string; code: string; opening_balance: string }>(
    `select kind, code, opening_balance::text from cbk_accounts where deleted_at is null order by code`,
  );
  const totals: Record<string, string> = {};
  for (const row of rows) {
    const slug = row.code.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
    totals[`${row.kind}.${slug}`] = Number(row.opening_balance).toFixed(2);
  }
  return totals;
}

/** BR-1: every control total against the loaded total; an empty list means zero difference everywhere. */
export async function verifyOpening(
  db: SqlDb,
  controlSheetMarkdown: string,
): Promise<OpeningDifference[]> {
  return compareOpening(parseControlSheet(controlSheetMarkdown), await loadedOpeningTotals(db));
}
