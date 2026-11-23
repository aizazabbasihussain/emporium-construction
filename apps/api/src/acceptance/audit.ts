import type { SqlDb } from '@emporium/db';

/** A money-changing table and the rows of it that must have an audit entry (P2-10 BR-5). */
const MONEY_TABLES: { table: string; label: string; where: string }[] = [
  { table: 'bil_invoices', label: 'invoice', where: "status <> 'draft'" },
  { table: 'bil_credit_notes', label: 'credit note', where: "status = 'issued'" },
  { table: 'bil_advances', label: 'advance', where: 'true' },
  { table: 'rcv_receipts', label: 'receipt', where: 'true' },
  { table: 'rcv_pdcs', label: 'post-dated cheque', where: 'true' },
  { table: 'pay_bills', label: 'vendor bill', where: "status <> 'draft'" },
  { table: 'pay_payments', label: 'vendor payment', where: "status = 'paid'" },
  { table: 'sub_certificates', label: 'subcontract certificate', where: "status <> 'draft'" },
  { table: 'pyr_runs', label: 'payroll run', where: 'true' },
  { table: 'pyr_payments', label: 'payroll payment', where: 'true' },
  { table: 'cbk_accounts', label: 'cash account', where: 'true' },
  { table: 'cbk_reconciliations', label: 'bank reconciliation', where: "status = 'completed'" },
];

/**
 * Every money-changing row that has no audit entry. The audit log is keyed by entity id, so a row
 * with a state beyond draft but no entry at all is a mutation that was not audited. Cash book
 * entries are covered through the document that created them, and each must have its own entry.
 */
export async function findUnauditedMoneyRows(db: SqlDb): Promise<string[]> {
  const gaps: string[] = [];
  for (const { table, label, where } of MONEY_TABLES) {
    const rows = await db.query<{ id: string }>(
      `select t.id::text as id from ${table} t
        where ${where}
          and not exists (select 1 from sys_audit_log a where a.entity_id = t.id::text)`,
    );
    gaps.push(...rows.map((row) => `${label} ${row.id}`));
  }
  const entries = await db.query<{ number: string }>(
    `select t.number from cbk_transactions t
      where not exists (select 1 from sys_audit_log a where a.entity_id = t.id::text)
        and not exists (select 1 from sys_audit_log a
                         where a.entity_id in (t.source_doc_id::text, t.approval_doc_id::text))`,
  );
  gaps.push(...entries.map((row) => `cash book entry ${row.number}`));
  return gaps;
}
