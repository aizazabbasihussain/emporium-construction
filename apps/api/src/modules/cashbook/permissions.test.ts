import { findTablesWithoutRls } from '@emporium/db';
import { cashbookPermissionGrants, cashbookPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TODAY, createCashbookKit, uid, type CashbookKit } from './test-support.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
}, 120_000);
afterAll(() => kit.close());

describe('cashbook permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(cashbookPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...cashbookPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant works, management reads and manages accounts', () => {
    const holders = new Set(Object.values(cashbookPermissionGrants).flat());
    expect([...holders].sort()).toEqual(['accountant', 'admin', 'management']);
    for (const permission of Object.values(cashbookPermissions)) {
      expect(cashbookPermissionGrants[permission]).toContain('accountant');
    }
    expect(cashbookPermissionGrants['cashbook.account.manage']).toContain('management');
    expect(cashbookPermissionGrants['cashbook.txn.read']).toContain('management');
    for (const permission of [
      'cashbook.txn.create',
      'cashbook.txn.reverse',
      'cashbook.reconciliation.manage',
    ] as const) {
      expect(cashbookPermissionGrants[permission]).not.toContain('management');
    }
  });
});

describe('cashbook schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('seeds the owner approval rule for adjustments and the gapless transaction series', async () => {
    const rules = await kit.db.query<{ doc_type: string; role_code: string }>(
      `select r.doc_type, s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type in ('cash_adjustment', 'payment') order by r.doc_type`,
    );
    expect(rules).toEqual([
      { doc_type: 'cash_adjustment', role_code: 'management' },
      { doc_type: 'payment', role_code: 'management' },
    ]);
    const series = await kit.db.query<{ gapless: boolean; prefix: string }>(
      "select gapless, prefix from sys_number_series where code = 'cash_txn'",
    );
    expect(series).toEqual([{ gapless: true, prefix: 'CB' }]);
  });

  it('exposes the published view with signed amounts and the reversal state (cbk_v_transactions)', async () => {
    const account = await kit.account({ kind: 'cash', openingBalance: '10' });
    const receipt = await kit.receive(account.id, '25');
    const payment = await kit.pay(account.id, '5');
    await kit.tx((tx) =>
      kit.cashbook.transactions.reverse(payment.id, { reason: 'Typo' }, kit.actor, tx),
    );
    const rows = await kit.db.query<Record<string, string | boolean>>(
      'select id, signed_amount::text as signed, reversed from cbk_v_transactions where account_id = $1 order by number',
      [account.id],
    );
    expect(rows.map((r) => [r.signed, r.reversed])).toEqual([
      ['25.00', false],
      ['-5.00', true],
      ['5.00', false],
    ]);
    expect(rows[0]?.id).toBe(receipt.id);
  });

  it('refuses rows that break the table rules', async () => {
    const account = await kit.account();
    const insert = (values: string) =>
      kit.db.query(
        `insert into cbk_transactions (id, number, account_id, txn_date, direction, amount, txn_type, method, idempotency_key)
         values (gen_random_uuid(), gen_random_uuid()::text, $1, '${TODAY}', ${values}, gen_random_uuid()::text)`,
        [account.id],
      );
    await expect(insert("'in', 0, 'receipt', 'cash'")).rejects.toThrow();
    await expect(insert("'out', 5, 'receipt', 'cash'")).rejects.toThrow();
    await expect(insert("'in', 5, 'payment', 'cash'")).rejects.toThrow();
    await expect(insert("'in', 5, 'receipt', 'barter'")).rejects.toThrow();
    await insert("'in', 5, 'other', 'cash'");
    await expect(
      kit.db.query(
        `insert into cbk_transactions (id, number, account_id, txn_date, direction, amount, txn_type, method, idempotency_key, reverses_id)
         select gen_random_uuid(), 'X-1', $1, '${TODAY}', 'out', 5, 'receipt', 'cash', 'k-1', id from cbk_transactions where account_id = $1 limit 1`,
        [account.id],
      ),
    ).rejects.toThrow();
  });

  it('refuses a second reversal of one entry and two entries with one number or key', async () => {
    const account = await kit.account();
    const receipt = await kit.receive(account.id, '5');
    await kit.tx((tx) =>
      kit.cashbook.transactions.reverse(receipt.id, { reason: 'First' }, kit.actor, tx),
    );
    await expect(
      kit.db.query(
        `insert into cbk_transactions (id, number, account_id, txn_date, direction, amount, txn_type, method, idempotency_key, reverses_id, reversal_reason)
         values (gen_random_uuid(), 'DUP', $1, '${TODAY}', 'out', 5, 'receipt', 'cash', 'dup-key', $2, 'Second')`,
        [account.id, receipt.id],
      ),
    ).rejects.toThrow();
    await expect(
      kit.db.query(
        `insert into cbk_transactions (id, number, account_id, txn_date, direction, amount, txn_type, method, idempotency_key)
         values (gen_random_uuid(), $2, $1, '${TODAY}', 'in', 5, 'receipt', 'cash', gen_random_uuid()::text)`,
        [account.id, receipt.number],
      ),
    ).rejects.toThrow();
    await expect(kit.db.query('truncate table cbk_transactions cascade')).rejects.toThrow();
  });

  it('a completed reconciliation needs a zero difference and a completing user', async () => {
    const account = await kit.account();
    await expect(
      kit.db.query(
        `insert into cbk_reconciliations (id, account_id, statement_from, statement_to, statement_closing_balance, status, difference, completed_by)
         values (gen_random_uuid(), $1, '2026-11-01', '2026-11-02', 0, 'completed', 5, $2)`,
        [account.id, uid(3)],
      ),
    ).rejects.toThrow();
    await expect(
      kit.db.query(
        `insert into cbk_reconciliations (id, account_id, statement_from, statement_to, statement_closing_balance)
         values (gen_random_uuid(), $1, '2026-11-02', '2026-11-01', 0)`,
        [account.id],
      ),
    ).rejects.toThrow();
  });
});
