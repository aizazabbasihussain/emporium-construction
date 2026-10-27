import { BusinessDate } from '@emporium/domain/kernel';
import { remainingCommitment } from '@emporium/domain/procurement';
import {
  postedCostOfLine,
  setPoLineCommitment,
  type PoLineRow,
  type PoRow,
} from '../repo/procurement.repo.js';
import type { Db } from '../types.js';
import type { Context } from './context.js';

/**
 * The commitments of a purchase order in the project cost ledger (BR-4, BR-5, BR-7, BR-9).
 *
 * Each order line has at most one live `committed` entry, keyed to the line (`commit_entry_id`).
 * Its amount is what has not been received yet: the line total less the cost of the receipts that
 * are still posted. Every change reverses the live entry and posts a new one, so the ledger shows
 * the whole history and the sums stay exact.
 */
export function createCommitments(ctx: Context) {
  const { projects, clock } = ctx;

  /** Reverses the live commitment of a line, if there is one. */
  async function release(tx: Db, line: PoLineRow, reason: string, by: string | null) {
    if (line.commit_entry_id !== null) {
      await projects.reverseCost(line.commit_entry_id, reason, tx, by);
      await setPoLineCommitment(tx, line.id, null, line.commit_seq);
    }
  }

  /**
   * Replaces the live commitment of a line by one for what is still to come. A line that has been
   * removed by an amendment, or is fully received, is left without a commitment.
   */
  async function recommit(
    tx: Db,
    po: Pick<PoRow, 'id' | 'revision' | 'project_id' | 'destination_type'>,
    line: PoLineRow,
    reason: string,
    by: string | null,
    keySuffix = '',
  ): Promise<void> {
    if (po.destination_type !== 'project') return;
    await release(tx, line, reason, by);
    const amount = line.removed
      ? '0.00'
      : remainingCommitment(line.line_total, await postedCostOfLine(tx, line.id));
    if (amount === '0.00') return;
    const seq = line.commit_seq + 1;
    const entry = await projects.postCost(
      {
        costObject: { type: 'project', id: po.project_id },
        costCodeId: line.cost_code_id,
        amount,
        status: 'committed',
        sourceModule: 'procurement',
        sourceDocType: 'purchase_order',
        sourceDocId: po.id,
        sourceLineId: line.id,
        entryDate: BusinessDate.today(clock).toString(),
        description: `PO commitment`,
        // BR-4: `po:<line id>:v<version>`; receipts add a suffix to keep their re-commitments apart.
        idempotencyKey: `po:${line.id}:v${po.revision}${keySuffix}`,
        actorUserId: by,
      },
      tx,
    );
    await setPoLineCommitment(tx, line.id, entry.id, seq);
  }

  return { release, recommit };
}

export type Commitments = ReturnType<typeof createCommitments>;
