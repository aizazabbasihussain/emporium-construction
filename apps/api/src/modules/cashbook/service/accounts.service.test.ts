import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TODAY, auditCount, createCashbookKit, uid, type CashbookKit } from '../test-support.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
}, 120_000);
afterAll(() => kit.close());

describe('accounts (BR-1)', () => {
  it("creates an account with an opening balance and reads it back with today's balance", async () => {
    const created = await kit.account({
      code: 'MAIN',
      name: '  Main till ',
      kind: 'cash',
      openingBalance: '2500.5',
      bankName: ' ',
      accountCodeTag: ' 1001 ',
    });
    expect(created).toMatchObject({
      code: 'MAIN',
      name: 'Main till',
      kind: 'cash',
      openingBalance: '2500.50',
      openingDate: '2026-01-01',
      allowOverdraft: false,
      active: true,
      bankName: null,
      accountCodeTag: '1001',
      balance: '2500.50',
    });
    await kit.receive(created.id, '100');
    expect((await kit.cashbook.accounts.get(kit.db, created.id)).balance).toBe('2600.50');
    expect(await auditCount(kit.db, 'cashbook.account.create')).toBeGreaterThan(0);
  });

  it('refuses a duplicate code (any letter case), a blank code or name, and an unmasked number', async () => {
    await kit.account({ code: 'DUP-1' });
    await expect(kit.account({ code: 'dup-1' })).rejects.toMatchObject({
      code: 'account_code_taken',
    });
    await expect(kit.account({ code: ' ' })).rejects.toMatchObject({ code: 'code_required' });
    await expect(kit.account({ name: ' ' })).rejects.toMatchObject({ code: 'name_required' });
    await expect(kit.account({ accountNumberMasked: '1234567890123' })).rejects.toMatchObject({
      code: 'account_number_not_masked',
    });
    const masked = await kit.account({ accountNumberMasked: '****1234' });
    expect(masked.accountNumberMasked).toBe('****1234');
  });

  it('opens below zero only for a bank account or wallet that may be overdrawn', async () => {
    await expect(kit.account({ kind: 'cash', openingBalance: '-1' })).rejects.toMatchObject({
      code: 'opening_balance_negative',
    });
    await expect(kit.account({ kind: 'bank', openingBalance: '-1' })).rejects.toMatchObject({
      code: 'opening_balance_negative',
    });
    const ok = await kit.account({ kind: 'bank', openingBalance: '-1', allowOverdraft: true });
    expect(ok.balance).toBe('-1.00');
    await expect(kit.account({ kind: 'petty_cash', allowOverdraft: true })).rejects.toMatchObject({
      code: 'overdraft_not_allowed',
    });
  });

  it('edits the descriptive fields but never the opening balance, date or kind', async () => {
    const account = await kit.account({ kind: 'bank', openingBalance: '10' });
    const updated = await kit.tx((tx) =>
      kit.cashbook.accounts.update(
        account.id,
        {
          name: 'Renamed',
          bankName: 'Synthetic Bank',
          accountNumberMasked: '****9',
          accountCodeTag: '1100',
          allowOverdraft: true,
          version: account.version,
        },
        kit.actor,
        tx,
      ),
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      bankName: 'Synthetic Bank',
      allowOverdraft: true,
      openingBalance: '10.00',
      active: true,
      version: account.version + 1,
    });
    // An update without the optional flags keeps them.
    const kept = await kit.tx((tx) =>
      kit.cashbook.accounts.update(
        account.id,
        { name: 'Renamed', version: updated.version },
        kit.actor,
        tx,
      ),
    );
    expect(kept).toMatchObject({ allowOverdraft: true, bankName: null });
    await expect(
      kit.db.query('update cbk_accounts set opening_balance = 99 where id = $1', [account.id]),
    ).rejects.toThrow();
    await expect(
      kit.db.query("update cbk_accounts set kind = 'cash' where id = $1", [account.id]),
    ).rejects.toThrow();
  });

  it('refuses a stale version, an overdraft flag on cash, and an unknown account', async () => {
    const till = await kit.account({ kind: 'cash' });
    await expect(
      kit.tx((tx) =>
        kit.cashbook.accounts.update(till.id, { name: 'X', version: 99 }, kit.actor, tx),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      kit.tx((tx) =>
        kit.cashbook.accounts.update(
          till.id,
          { name: 'X', allowOverdraft: true, version: till.version },
          kit.actor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'overdraft_not_allowed' });
    await expect(
      kit.tx((tx) =>
        kit.cashbook.accounts.update(uid(900), { name: 'X', version: 1 }, kit.actor, tx),
      ),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(kit.cashbook.accounts.get(kit.db, uid(900))).rejects.toMatchObject({
      code: 'account_not_found',
    });
    await expect(kit.cashbook.accounts.getBalance(kit.db, uid(900), TODAY)).rejects.toMatchObject({
      code: 'account_not_found',
    });
  });

  it('lists active accounts, optionally the inactive ones, and deletes only an unused account', async () => {
    const own = await createCashbookKit();
    try {
      const keep = await own.account({ code: 'B' });
      const off = await own.account({ code: 'A' });
      const used = await own.account({ code: 'C' });
      await own.receive(used.id, '5');
      await own.tx((tx) =>
        own.cashbook.accounts.update(
          off.id,
          { name: off.name, active: false, version: off.version },
          own.actor,
          tx,
        ),
      );
      expect((await own.cashbook.accounts.list(own.db, false)).map((a) => a.code)).toEqual([
        'B',
        'C',
      ]);
      expect((await own.cashbook.accounts.list(own.db, true)).map((a) => a.code)).toEqual([
        'A',
        'B',
        'C',
      ]);
      await expect(
        own.tx((tx) => own.cashbook.accounts.remove(used.id, used.version, own.actor, tx)),
      ).rejects.toMatchObject({ code: 'account_in_use' });
      await expect(
        own.tx((tx) => own.cashbook.accounts.remove(keep.id, 99, own.actor, tx)),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      await expect(
        own.tx((tx) => own.cashbook.accounts.remove(uid(901), 1, own.actor, tx)),
      ).rejects.toMatchObject({ code: 'account_not_found' });
      await own.tx((tx) => own.cashbook.accounts.remove(keep.id, keep.version, own.actor, tx));
      expect((await own.cashbook.accounts.list(own.db, true)).map((a) => a.code)).toEqual([
        'A',
        'C',
      ]);
      // The code is free again once the account is deleted.
      await own.account({ code: 'B' });
    } finally {
      await own.close();
    }
  }, 60_000);
});
