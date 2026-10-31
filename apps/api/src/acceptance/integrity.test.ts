import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityChecks, runIntegrityChecks, type IntegrityCheck } from './integrity.js';

const id = (n: number) => `018f9100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const STORE = id(1);
const ITEM = id(2);
const PROJECT = id(3);
const CODE = id(4);

async function checksOf(db: SqlDb): Promise<IntegrityCheck[]> {
  return [...new Set((await runIntegrityChecks(db)).map((finding) => finding.check))];
}

async function seedHealthy(db: SqlDb): Promise<void> {
  await db.query(
    `insert into inv_stores (id, code, name, kind) values ($1, 'W1', 'Warehouse', 'warehouse')`,
    [STORE],
  );
  await db.query(
    `insert into inv_ledger (id, store_id, item_id, ownership, movement_type, quantity, unit_cost, value,
                             source_doc_type, source_doc_id, business_date, idempotency_key)
     values ($1, $2, $3, 'company', 'receipt', 10, 5, 50, 'grn', $4, '2026-10-26', 'k-1')`,
    [id(10), STORE, ITEM, id(11)],
  );
  await db.query(
    `insert into inv_balances (id, store_id, item_id, ownership, quantity) values ($1, $2, $3, 'company', 10)`,
    [id(12), STORE, ITEM],
  );
  await db.query(
    `insert into val_movements (id, store_id, item_id, type, quantity, value, unit_cost, method_used,
                                posting_date, idempotency_key)
     values ($1, $2, $3, 'receipt', 10, 50, 5, 'weighted_average', '2026-10-26', 'v-1')`,
    [id(13), STORE, ITEM],
  );
  await db.query(
    `insert into val_wa_state (store_id, item_id, quantity, total_value) values ($1, $2, 10, 50)`,
    [STORE, ITEM],
  );
  await db.query(
    `insert into prj_cost_entries (id, cost_object_type, cost_object_id, cost_code_id, amount, status,
                                   source_module, source_doc_type, source_doc_id, chain_key, entry_date,
                                   idempotency_key)
     values ($1, 'project', $2, $3, 50, 'approved', 'inventory', 'issue', $4, 'chain-1', '2026-10-26', 'c-1')`,
    [id(14), PROJECT, CODE, id(15)],
  );
}

describe('integrity checks (P1-21 BR-6)', () => {
  let db: SqlDb;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('reports nothing on an empty database', async () => {
    expect(await runIntegrityChecks(db)).toEqual([]);
  });

  it('reports nothing on consistent stock, valuation and cost data', async () => {
    await seedHealthy(db);
    expect(await runIntegrityChecks(db)).toEqual([]);
  });

  it('lists every check by name', () => {
    expect(integrityChecks).toHaveLength(6);
  });

  it('detects a negative balance', async () => {
    await seedHealthy(db);
    await db.exec('alter table inv_balances drop constraint inv_balances_quantity_check');
    await db.query('update inv_balances set quantity = -2');
    expect(await checksOf(db)).toContain('negative_balance');
  });

  it('detects a balance that differs from its ledger', async () => {
    await seedHealthy(db);
    await db.query('update inv_balances set quantity = 9');
    expect(await checksOf(db)).toEqual(['balance_ledger_mismatch']);
  });

  it('detects a ledger key without a balance row', async () => {
    await seedHealthy(db);
    await db.query('delete from inv_balances');
    expect(await checksOf(db)).toEqual(['balance_ledger_mismatch']);
  });

  it('detects value drift in the weighted average state', async () => {
    await seedHealthy(db);
    await db.query('update val_wa_state set total_value = 50.01');
    expect(await checksOf(db)).toEqual(['valuation_value_drift']);
  });

  it('detects value drift in a FIFO layer and accepts the corrected layer', async () => {
    await seedHealthy(db);
    await db.query('update val_wa_state set total_value = 0, quantity = 0');
    await db.query(
      `insert into val_layers (id, store_id, item_id, received_seq, remaining_qty, remaining_value, unit_cost, original_qty)
       values ($1, $2, $3, 1, 10, 50.5, 5, 10)`,
      [id(20), STORE, ITEM],
    );
    expect(await checksOf(db)).toEqual(['valuation_value_drift']);
    await db.query('update val_layers set remaining_value = 50');
    expect(await checksOf(db)).toEqual([]);
  });

  it('detects a cost summary that differs from its source entries', async () => {
    await seedHealthy(db);
    await db.exec(`create or replace view prj_v_cost_summary as
      select cost_object_type, cost_object_id, cost_code_id, 0::numeric(18,2) as committed,
             1::numeric(18,2) as approved, 0::numeric(18,2) as posted
        from prj_cost_entries`);
    expect(await checksOf(db)).toEqual(['cost_summary_mismatch']);
  });

  it('ignores a reversed chain when comparing the cost summary', async () => {
    await seedHealthy(db);
    await db.query(
      `insert into prj_cost_entries (id, cost_object_type, cost_object_id, cost_code_id, amount, status,
                                     source_module, source_doc_type, source_doc_id, chain_key, entry_date,
                                     idempotency_key, reverses_entry_id)
       values ($1, 'project', $2, $3, 50, 'reversed', 'inventory', 'issue', $4, 'chain-1', '2026-10-26', 'c-2', $5)`,
      [id(30), PROJECT, CODE, id(15), id(14)],
    );
    expect(await runIntegrityChecks(db)).toEqual([]);
  });

  it('detects an orphan (undelivered) outbox event and a failed one', async () => {
    await db.query(`insert into sys_outbox (id, type, payload) values ($1, 'a.b', '{}')`, [id(40)]);
    expect(await checksOf(db)).toEqual(['outbox_pending']);
    await db.query(`update sys_outbox set failed_at = now(), last_error = 'boom'`);
    expect(await checksOf(db)).toEqual(['outbox_failed']);
    await db.query(`update sys_outbox set failed_at = null, dispatched_at = now()`);
    expect(await runIntegrityChecks(db)).toEqual([]);
  });
});
