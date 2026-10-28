import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  STOREKEEPER2,
  NOBODY,
  PM,
  STOREKEEPER,
  SUPERVISOR,
  SUPERVISOR2,
  auditCount,
  createExpensesKit,
  eventCount,
  type ExpensesKit,
} from '../test-support.js';

let kit: ExpensesKit;
beforeAll(async () => {
  kit = await createExpensesKit();
}, 60_000);
afterAll(() => kit.close());

const accountant = () => kit.actorFor(ACCOUNTANT);
const code = (error: string) => expect.objectContaining({ code: error }) as Error;
const balance = (userId: string) => kit.expenses.getCustodianBalance(kit.db, userId);

const issue = (over: Partial<Parameters<typeof kit.expenses.advances.issue>[0]> = {}) =>
  kit.db.transaction((tx) =>
    kit.expenses.advances.issue(
      {
        custodianId: PM,
        amount: '1000',
        issuedOn: '2026-10-24',
        purpose: 'Petty cash',
        ...over,
      },
      accountant(),
      tx,
    ),
  );

const settle = async (id: string, note?: string, version?: number) => {
  const current = version ?? (await kit.advanceVersion(id));
  return kit.db.transaction((tx) =>
    kit.expenses.advances.settle(id, { note }, current, accountant(), tx),
  );
};

describe('issuing advances (BR-8)', () => {
  it('records custodian, amount and purpose and announces advance.issued', async () => {
    await kit.custodian(PM);
    const before = await eventCount(kit.db, 'advance.issued');
    const advance = await issue({ amount: '2500.5', purpose: '  Cement run  ' });
    expect(advance).toMatchObject({
      custodianId: PM,
      amount: '2500.50',
      purpose: 'Cement run',
      status: 'issued',
      issuedBy: ACCOUNTANT,
      settledOn: null,
      settlementNote: null,
    });
    expect(advance.number).toMatch(/^ADV-2026-\d{4}$/);
    expect(await eventCount(kit.db, 'advance.issued')).toBe(before + 1);
    expect(await auditCount(kit.db, 'expenses.advance.issue')).toBeGreaterThan(0);
  });

  it('needs a registered, active custodian, a positive amount, a purpose and a sane date', async () => {
    await expect(issue({ custodianId: SUPERVISOR })).rejects.toThrow(code('custodian_not_found'));
    await kit.custodian(STOREKEEPER);
    await kit.db.transaction((tx) =>
      kit.expenses.advances.saveCustodian(
        STOREKEEPER,
        { floatLimit: '0', active: false },
        accountant(),
        tx,
      ),
    );
    await expect(issue({ custodianId: STOREKEEPER })).rejects.toThrow(code('custodian_inactive'));
    await kit.custodian(PM);
    await expect(issue({ amount: '0' })).rejects.toThrow(code('amount_not_positive'));
    await expect(issue({ amount: '1.234' })).rejects.toThrow(code('amount_invalid'));
    await expect(issue({ purpose: ' ' })).rejects.toThrow(code('purpose_required'));
    await expect(issue({ issuedOn: '2026-10-26' })).rejects.toThrow(code('date_in_future'));
    await expect(issue({ issuedOn: '2026-10-01' })).rejects.toThrow(code('backdating_not_allowed'));
  });

  it('lists advances for finance and only a claimant’s own for a claimant', async () => {
    await issue({ custodianId: PM, amount: '11' });
    await kit.custodian(STOREKEEPER);
    await kit.db.transaction((tx) =>
      kit.expenses.advances.saveCustodian(
        STOREKEEPER,
        { floatLimit: '10', active: true },
        accountant(),
        tx,
      ),
    );
    await issue({ custodianId: STOREKEEPER, amount: '22' });
    const all = await kit.expenses.advances.list(kit.db, { limit: 200, offset: 0 }, accountant());
    expect(new Set(all.items.map((a) => a.custodianId))).toEqual(new Set([PM, STOREKEEPER]));
    const filtered = await kit.expenses.advances.list(
      kit.db,
      { custodianId: STOREKEEPER, status: 'issued', limit: 200, offset: 0 },
      accountant(),
    );
    expect(filtered.items.every((a) => a.custodianId === STOREKEEPER)).toBe(true);
    const own = await kit.expenses.advances.list(
      kit.db,
      { custodianId: STOREKEEPER, limit: 200, offset: 0 },
      kit.actorFor(PM),
    );
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every((a) => a.custodianId === PM)).toBe(true);
    const page = await kit.expenses.advances.list(kit.db, { limit: 1, offset: 1 }, accountant());
    expect(page).toMatchObject({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
  });
});

describe('custodian balance (BR-1, T-1, AC-3)', () => {
  it('follows the scripted scenario across advances and claims in every status', async () => {
    const who = SUPERVISOR;
    expect(await balance(who)).toBe('0.00');
    await kit.advance(who, '10000');
    expect(await balance(who)).toBe('10000.00');

    // Draft and submitted claims do not count.
    await kit.draft({ lines: [kit.line({ amount: '1000' })] }, who);
    const submitted = await kit.draft({ lines: [kit.line({ amount: '2000' })] }, who);
    await kit.submit(submitted, who);
    expect(await balance(who)).toBe('10000.00');

    // Approved and posted claims do.
    const approved = await kit.approved({ lines: [kit.line({ amount: '3000' })] }, who);
    expect(await balance(who)).toBe('7000.00');
    const posted = await kit.posted({ lines: [kit.line({ amount: '1500' })] }, who);
    expect(await balance(who)).toBe('5500.00');

    // Rejected, returned and cancelled claims do not.
    const rejected = await kit.draft({ lines: [kit.line({ amount: '700' })] }, who);
    await kit.submit(rejected, who);
    await kit.decide(rejected, 'reject');
    const returned = await kit.draft({ lines: [kit.line({ amount: '800' })] }, who);
    await kit.submit(returned, who);
    await kit.decide(returned, 'return');
    expect(await balance(who)).toBe('5500.00');

    // Cancelling the approved claim and reversing the posted one give the money back.
    const accountantActor = accountant();
    const approvedVersion = await versionOf(approved);
    await kit.db.transaction((tx) =>
      kit.expenses.claims.cancel(approved, {}, approvedVersion, accountantActor, tx),
    );
    expect(await balance(who)).toBe('8500.00');
    const postedVersion = await versionOf(posted);
    await kit.db.transaction((tx) =>
      kit.expenses.claims.reverse(posted, 'Wrong month', postedVersion, accountantActor, tx),
    );
    expect(await balance(who)).toBe('10000.00');
  });

  it('goes negative when claims exceed the advances: reported, not blocked', async () => {
    await kit.advance(STOREKEEPER, '100');
    await kit.approved({ lines: [kit.line({ amount: '250.50' })] }, STOREKEEPER);
    // The earlier advance of 22.00 is still counted.
    expect(await balance(STOREKEEPER)).toBe('-128.50');
    const dto = await kit.expenses.advances.getCustodian(kit.db, STOREKEEPER, accountant());
    expect(dto).toMatchObject({ userId: STOREKEEPER, balance: '-128.50', active: true });
  });
});

describe('settling advances (BR-8)', () => {
  it('settles on its own when the balance returns to zero', async () => {
    const custodian = SUPERVISOR2;
    const advance = await kit.advance(custodian, '400');
    expect(await balance(custodian)).toBe('400.00');
    const events = await eventCount(kit.db, 'expenses.advance.changed');
    await kit.approved({ lines: [kit.line({ amount: '400' })] }, custodian);
    expect(await balance(custodian)).toBe('0.00');
    const page = await kit.expenses.advances.list(
      kit.db,
      { custodianId: custodian, limit: 50, offset: 0 },
      accountant(),
    );
    expect(page.items.find((a) => a.id === advance)).toMatchObject({
      status: 'settled',
      settledOn: '2026-10-25',
      settlementNote: null,
    });
    expect(await eventCount(kit.db, 'expenses.advance.changed')).toBe(events + 1);
  });

  it('settles by hand with a note unless the balance is zero', async () => {
    const advance = await kit.advance(PM, '900');
    await expect(settle(advance)).rejects.toThrow(code('note_required'));
    await expect(settle(advance, '  ')).rejects.toThrow(code('note_required'));
    const settled = await settle(advance, ' Cash returned to the office ');
    expect(settled).toMatchObject({
      status: 'settled',
      settlementNote: 'Cash returned to the office',
      settledOn: '2026-10-25',
    });
    await expect(settle(advance, 'again')).rejects.toThrow(code('advance_not_issued'));
  });

  it('settles without a note when the balance is zero', async () => {
    // The claim comes first, so issuing the advance brings the balance to zero without settling it.
    await kit.custodian(STOREKEEPER2);
    await kit.approved({ lines: [kit.line({ amount: '100' })] }, STOREKEEPER2);
    const advance = await kit.advance(STOREKEEPER2, '100');
    expect(await balance(STOREKEEPER2)).toBe('0.00');
    expect(await settle(advance)).toMatchObject({ status: 'settled', settlementNote: null });
  });

  it('checks the version and the id', async () => {
    await kit.custodian(NOBODY);
    const advance = await kit.db.transaction((tx) =>
      kit.expenses.advances.issue(
        { custodianId: NOBODY, amount: '10', issuedOn: '2026-10-25', purpose: 'Test' },
        accountant(),
        tx,
      ),
    );
    await expect(settle(advance.id, 'x', 999)).rejects.toThrow(code('version_conflict'));
    await expect(settle('018f0000-0000-7000-8000-000000000999', 'x', 1)).rejects.toThrow(
      code('advance_not_found'),
    );
  });
});

describe('custodians', () => {
  it('registers and updates a custodian with a float limit', async () => {
    const save = (input: Parameters<typeof kit.expenses.advances.saveCustodian>[1]) =>
      kit.db.transaction((tx) =>
        kit.expenses.advances.saveCustodian(ACCOUNTANT, input, accountant(), tx),
      );
    const first = await save({ floatLimit: '5000', active: true });
    expect(first).toMatchObject({
      userId: ACCOUNTANT,
      floatLimit: '5000.00',
      active: true,
      version: 1,
    });
    const second = await save({ floatLimit: '7500.25', active: true, version: 1 });
    expect(second).toMatchObject({ floatLimit: '7500.25', version: 2 });
    await expect(save({ floatLimit: '1', active: true, version: 1 })).rejects.toThrow(
      code('version_conflict'),
    );
    await expect(save({ floatLimit: '-1', active: true })).rejects.toThrow(
      code('float_limit_invalid'),
    );
    // Without a version the latest row is changed.
    expect(await save({ floatLimit: '1', active: false })).toMatchObject({
      version: 3,
      active: false,
    });
  });

  it('refuses a user who does not exist or is not active', async () => {
    await expect(
      kit.db.transaction((tx) =>
        kit.expenses.advances.saveCustodian(
          '018f0000-0000-7000-8000-000000000999',
          { floatLimit: '1', active: true },
          accountant(),
          tx,
        ),
      ),
    ).rejects.toThrow(code('user_unknown'));
    await kit.db.query(`update sys_users set status = 'disabled' where id = $1`, [NOBODY]);
    await expect(
      kit.db.transaction((tx) =>
        kit.expenses.advances.saveCustodian(
          NOBODY,
          { floatLimit: '1', active: true },
          accountant(),
          tx,
        ),
      ),
    ).rejects.toThrow(code('user_unknown'));
  });

  it('offers the active users as candidates', async () => {
    const people = await kit.expenses.advances.candidates(kit.db);
    expect(people.map((p) => p.id)).toContain(PM);
    expect(people.find((p) => p.id === PM)).toEqual({
      id: PM,
      fullName: 'pm@example.test',
      email: 'pm@example.test',
    });
    // NOBODY was disabled by the test above.
    expect(people.map((p) => p.id)).not.toContain(NOBODY);
  });

  it('lists custodians with their balances and shows a claimant only their own', async () => {
    const list = await kit.expenses.advances.listCustodians(kit.db);
    expect(list.map((c) => c.userId)).toContain(PM);
    expect(list.find((c) => c.userId === PM)?.balance).toBe(await balance(PM));
    expect(await kit.expenses.advances.getCustodian(kit.db, PM, kit.actorFor(PM))).toMatchObject({
      userId: PM,
    });
    await expect(
      kit.expenses.advances.getCustodian(kit.db, PM, kit.actorFor(STOREKEEPER)),
    ).rejects.toThrow(code('custodian_not_found'));
    await expect(
      kit.expenses.advances.getCustodian(
        kit.db,
        '018f0000-0000-7000-8000-000000000999',
        accountant(),
      ),
    ).rejects.toThrow(code('custodian_not_found'));
  });
});

const versionOf = (id: string) => kit.version(id);
