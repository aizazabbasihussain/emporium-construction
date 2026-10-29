import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  PM,
  STOREKEEPER,
  createExpensesKit,
  type ExpensesKit,
} from '../test-support.js';
import {
  findAdvance,
  findCategory,
  findClaim,
  findCustodian,
  insertAdvance,
  insertClaim,
  listAdvancesOf,
  listCategories,
  listCountedClaims,
  listCustodians,
  listLines,
  listPriorLines,
  replaceLines,
  searchAdvances,
  searchClaims,
  setLineEntry,
  softDeleteClaim,
  updateAdvance,
  updateClaim,
  upsertCategory,
  upsertCustodian,
} from './expenses.repo.js';

let kit: ExpensesKit;
const at = new Date('2026-10-25T10:00:00Z');
let seq = 0;
const id = () => `018f7d7d-7777-7000-8000-${String(++seq).padStart(12, '0')}`;

beforeAll(async () => {
  kit = await createExpensesKit();
}, 60_000);
afterAll(() => kit.close());

const newClaim = (claimant = PM, over: Record<string, unknown> = {}) =>
  insertClaim(
    kit.db,
    { id: id(), number: `REPO-${seq}`, claimant_id: claimant, total: '100.00', ...over },
    claimant,
    at,
  );

const lineFor = (over: Partial<Parameters<typeof replaceLines>[2][number]> = {}) => ({
  id: id(),
  lineNo: 1,
  expenseDate: '2026-10-23',
  category: 'transport',
  description: 'Van',
  costObjectType: 'overhead',
  costObjectId: null,
  costCodeId: kit.codes['500'] as string,
  amount: '100.00',
  receiptFileId: null,
  ...over,
});

describe('claims', () => {
  it('inserts, finds, updates with the version and soft deletes', async () => {
    const claim = await newClaim();
    expect(claim).toMatchObject({
      status: 'draft',
      total: '100.00',
      note: '',
      submitted_on: null,
      cancel_reason: null,
      version: 1,
    });
    expect(await findClaim(kit.db, claim.id)).toEqual(claim);
    expect(await findClaim(kit.db, claim.id, true)).toEqual(claim);
    expect(await findClaim(kit.db, id())).toBeUndefined();

    const updated = await updateClaim(
      kit.db,
      claim.id,
      1,
      { status: 'submitted', submitted_on: '2026-10-25' },
      PM,
      at,
    );
    expect(updated).toMatchObject({ status: 'submitted', submitted_on: '2026-10-25', version: 2 });
    expect(await updateClaim(kit.db, claim.id, 1, { note: 'late' }, PM, at)).toBeUndefined();

    expect(await softDeleteClaim(kit.db, claim.id, 1, PM, at)).toBe(false);
    expect(await softDeleteClaim(kit.db, claim.id, 2, PM, at)).toBe(true);
    expect(await findClaim(kit.db, claim.id)).toBeUndefined();
  });

  it('searches by claimant and status, newest first, with a page', async () => {
    const a = await newClaim(STOREKEEPER, { status: 'approved' });
    const b = await newClaim(STOREKEEPER);
    const mine = await searchClaims(kit.db, { claimantId: STOREKEEPER, limit: 10, offset: 0 });
    expect(mine.rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(mine.total).toBe(2);
    const approved = await searchClaims(kit.db, {
      claimantId: STOREKEEPER,
      status: 'approved',
      limit: 10,
      offset: 0,
    });
    expect(approved.rows.map((r) => r.id)).toEqual([a.id]);
    const page = await searchClaims(kit.db, { claimantId: STOREKEEPER, limit: 1, offset: 1 });
    expect(page.rows.map((r) => r.id)).toEqual([a.id]);
    const everyone = await searchClaims(kit.db, { limit: 500, offset: 0 });
    expect(everyone.total).toBeGreaterThanOrEqual(2);
  });

  it('replaces the lines as a whole and remembers the latest cost entry', async () => {
    const claim = await newClaim();
    await replaceLines(kit.db, claim.id, [lineFor(), lineFor({ lineNo: 2, amount: '5.50' })]);
    expect((await listLines(kit.db, claim.id)).map((l) => [l.line_no, l.amount])).toEqual([
      [1, '100.00'],
      [2, '5.50'],
    ]);
    await replaceLines(kit.db, claim.id, [lineFor({ description: 'Only one' })]);
    const [line] = await listLines(kit.db, claim.id);
    expect(await listLines(kit.db, claim.id)).toHaveLength(1);
    expect(line).toMatchObject({
      description: 'Only one',
      cost_object_type: 'overhead',
      cost_object_id: null,
      receipt_file_id: null,
      cost_entry_id: null,
      expense_date: '2026-10-23',
    });
    const entry = id();
    await setLineEntry(kit.db, (line as { id: string }).id, entry);
    expect((await listLines(kit.db, claim.id))[0]?.cost_entry_id).toBe(entry);
  });

  it('finds prior lines of the claimant in a window, not rejected or cancelled claims', async () => {
    const claimant = STOREKEEPER;
    const live = await newClaim(claimant, { number: 'REPO-LIVE' });
    const rejected = await newClaim(claimant, { number: 'REPO-REJ', status: 'rejected' });
    const cancelled = await newClaim(claimant, { number: 'REPO-CAN', status: 'cancelled' });
    const mine = await newClaim(claimant, { number: 'REPO-SELF' });
    for (const claim of [live, rejected, cancelled, mine]) {
      await replaceLines(kit.db, claim.id, [lineFor({ amount: '777.00' })]);
    }
    await replaceLines(kit.db, live.id, [
      lineFor({ amount: '777.00' }),
      lineFor({ lineNo: 2, amount: '777.00', expenseDate: '2026-09-01' }),
    ]);
    const found = await listPriorLines(kit.db, claimant, mine.id, '2026-10-16', '2026-10-30');
    expect(found).toEqual([
      {
        claim_number: 'REPO-LIVE',
        line_no: 1,
        expense_date: '2026-10-23',
        category: 'transport',
        amount: '777.00',
      },
    ]);
  });

  it('counts only approved and posted claims of a claimant', async () => {
    const claimant = STOREKEEPER;
    for (const status of ['draft', 'submitted', 'approved', 'rejected', 'returned', 'posted']) {
      await newClaim(claimant, { status, total: status === 'approved' ? '30.00' : '40.00' });
    }
    const counted = await listCountedClaims(kit.db, claimant);
    // One approved claim was made by the search test above.
    expect(counted.map((c) => c.status).sort()).toEqual(['approved', 'approved', 'posted']);
    expect(counted.find((c) => c.status === 'posted')).toMatchObject({ total: '40.00' });
  });
});

describe('custodians and advances', () => {
  it('registers, updates and lists custodians', async () => {
    expect(await findCustodian(kit.db, PM)).toBeUndefined();
    const created = await upsertCustodian(
      kit.db,
      { userId: PM, floatLimit: '5000', active: true },
      ACCOUNTANT,
      at,
    );
    expect(created).toEqual({ user_id: PM, float_limit: '5000.00', active: true, version: 1 });
    expect(await findCustodian(kit.db, PM, true)).toEqual(created);
    const changed = await upsertCustodian(
      kit.db,
      { userId: PM, floatLimit: '100', active: false, expectedVersion: 1 },
      ACCOUNTANT,
      at,
    );
    expect(changed).toMatchObject({ float_limit: '100.00', active: false, version: 2 });
    expect(
      await upsertCustodian(
        kit.db,
        { userId: PM, floatLimit: '1', active: true, expectedVersion: 1 },
        ACCOUNTANT,
        at,
      ),
    ).toBeUndefined();
    expect((await listCustodians(kit.db)).map((c) => c.user_id)).toContain(PM);
  });

  it('inserts, finds, updates, searches and lists the advances of a custodian', async () => {
    await upsertCustodian(
      kit.db,
      { userId: STOREKEEPER, floatLimit: '0', active: true },
      ACCOUNTANT,
      at,
    );
    const make = (amount: string) =>
      insertAdvance(
        kit.db,
        {
          id: id(),
          number: `ADV-REPO-${seq}`,
          custodian_id: STOREKEEPER,
          amount,
          issued_on: '2026-10-24',
          issued_by: ACCOUNTANT,
          purpose: 'Petty cash',
        },
        ACCOUNTANT,
        at,
      );
    const first = await make('100');
    const second = await make('50.5');
    expect(first).toMatchObject({
      status: 'issued',
      amount: '100.00',
      issued_on: '2026-10-24',
      settled_on: null,
      settlement_note: null,
      version: 1,
    });
    expect(await findAdvance(kit.db, first.id)).toEqual(first);
    expect(await findAdvance(kit.db, first.id, true)).toEqual(first);
    expect(await findAdvance(kit.db, id())).toBeUndefined();

    const settled = await updateAdvance(
      kit.db,
      first.id,
      1,
      { status: 'settled', settled_on: '2026-10-25', settlement_note: 'done' },
      ACCOUNTANT,
      at,
    );
    expect(settled).toMatchObject({ status: 'settled', settled_on: '2026-10-25', version: 2 });
    expect(
      await updateAdvance(kit.db, first.id, 1, { purpose: 'x' }, ACCOUNTANT, at),
    ).toBeUndefined();

    const all = await searchAdvances(kit.db, { custodianId: STOREKEEPER, limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(all.total).toBe(2);
    const issued = await searchAdvances(kit.db, { status: 'issued', limit: 10, offset: 0 });
    expect(issued.rows.map((r) => r.id)).toContain(second.id);
    expect(issued.rows.map((r) => r.id)).not.toContain(first.id);
    expect((await listAdvancesOf(kit.db, STOREKEEPER)).map((r) => r.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

describe('categories', () => {
  it('adds, changes and lists categories', async () => {
    expect(await findCategory(kit.db, 'tools')).toBeUndefined();
    const added = await upsertCategory(
      kit.db,
      {
        code: 'tools',
        name: 'Small tools',
        defaultCostCodeId: null,
        receiptRequired: true,
        maxWithoutReceipt: '500',
      },
      ACCOUNTANT,
      at,
    );
    expect(added).toEqual({
      code: 'tools',
      name: 'Small tools',
      default_cost_code_id: null,
      receipt_required: true,
      max_without_receipt: '500.00',
      version: 1,
    });
    const changed = await upsertCategory(
      kit.db,
      {
        code: 'tools',
        name: 'Tools',
        defaultCostCodeId: kit.codes['500'] as string,
        receiptRequired: false,
        maxWithoutReceipt: '0',
      },
      ACCOUNTANT,
      at,
    );
    expect(changed).toMatchObject({ name: 'Tools', version: 2, receipt_required: false });
    expect(await findCategory(kit.db, 'tools')).toEqual(changed);
    expect((await listCategories(kit.db)).map((c) => c.code)).toEqual(['tools', 'transport']);
  });
});

describe('constraints', () => {
  it('refuses a line whose cost object does not fit its type, and a non-positive amount', async () => {
    const claim = await newClaim();
    await expect(
      replaceLines(kit.db, claim.id, [lineFor({ costObjectType: 'project', costObjectId: null })]),
    ).rejects.toThrow();
    await expect(replaceLines(kit.db, claim.id, [lineFor({ amount: '0' })])).rejects.toThrow();
    await expect(replaceLines(kit.db, claim.id, [lineFor({ category: 'nope' })])).rejects.toThrow();
  });
});
