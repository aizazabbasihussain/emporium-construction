import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
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
let projectId: string;
beforeAll(async () => {
  kit = await createExpensesKit();
  projectId = (await kit.project()).id;
}, 60_000);
afterAll(() => kit.close());

const accountant = () => kit.actorFor(ACCOUNTANT);
const code = (error: string) => expect.objectContaining({ code: error }) as Error;

const get = (id: string, userId = PM) => kit.expenses.claims.get(kit.db, id, kit.actorFor(userId));

/** The current version, read before a transaction opens (the test database has one connection). */
const versionOf = async (id: string) => (await get(id, ACCOUNTANT)).version;

const cancel = async (id: string, userId = PM, reason?: string) => {
  const version = await versionOf(id);
  return kit.db.transaction((tx) =>
    kit.expenses.claims.cancel(id, { reason }, version, kit.actorFor(userId), tx),
  );
};

const reverse = async (id: string, reason = 'Entered twice') => {
  const version = await versionOf(id);
  return kit.db.transaction((tx) =>
    kit.expenses.claims.reverse(id, reason, version, accountant(), tx),
  );
};

const post = async (id: string) => {
  const version = await versionOf(id);
  return kit.db.transaction((tx) => kit.expenses.claims.post(id, version, accountant(), tx));
};

const create = (over: Parameters<ExpensesKit['input']>[0] = {}, userId = PM) =>
  kit.db.transaction((tx) => kit.expenses.claims.create(kit.input(over), kit.actorFor(userId), tx));

const update = async (
  id: string,
  over: Parameters<ExpensesKit['input']>[0] = {},
  userId = PM,
  version?: number,
) => {
  const current = version ?? (await versionOf(id));
  return kit.db.transaction((tx) =>
    kit.expenses.claims.update(id, kit.input(over), current, kit.actorFor(userId), tx),
  );
};

const submit = async (id: string, userId = PM, acknowledge = false) => {
  const version = await versionOf(id);
  return kit.db.transaction((tx) =>
    kit.expenses.claims.submit(
      id,
      { acknowledgeDuplicates: acknowledge },
      version,
      kit.actorFor(userId),
      tx,
    ),
  );
};

describe('approve and post (AC-1, AC-2, BR-4 to BR-6)', () => {
  it('books approved cost on approval and posted cost when the accountant posts', async () => {
    const line = kit.line({
      costObjectType: 'project',
      costObjectId: projectId,
      amount: '2500.50',
    });
    const id = await kit.draft({ lines: [line] });
    const draft = await get(id);
    expect(draft).toMatchObject({ status: 'draft', total: '2500.50' });
    expect(draft.number).toMatch(/^EXP-2026-\d{4}$/);

    // AC-2: nothing is cost before approval.
    await kit.submit(id);
    expect(await kit.entries(projectId)).toEqual([]);
    expect((await get(id)).approval).toMatchObject({ status: 'pending' });

    const approvedBefore = await eventCount(kit.db, 'expense.approved');
    await kit.decide(id, 'approve');
    const approved = await get(id);
    expect(approved.status).toBe('approved');
    expect(await kit.entries(projectId)).toEqual([
      { status: 'approved', amount: '2500.50', sourceLineId: approved.lines[0]?.id },
    ]);
    expect(await eventCount(kit.db, 'expense.approved')).toBe(approvedBefore + 1);

    const postedBefore = await eventCount(kit.db, 'expense.posted');
    const posted = await kit.db.transaction((tx) =>
      kit.expenses.claims.post(id, approved.version, accountant(), tx),
    );
    expect(posted.status).toBe('posted');
    expect((await kit.entries(projectId)).map((e) => e.status).sort()).toEqual([
      'approved',
      'posted',
    ]);
    const summary = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    expect(summary.totals).toMatchObject({ approved: '0.00', posted: '2500.50' });
    expect(await eventCount(kit.db, 'expense.posted')).toBe(postedBefore + 1);
    expect(await auditCount(kit.db, 'expenses.claim.post')).toBeGreaterThan(0);
  });

  it('posts only approved claims, once', async () => {
    const id = await kit.approved();
    await post(id);
    await expect(post(id)).rejects.toThrow(code('claim_transition'));
    const draft = await kit.draft();
    await expect(post(draft)).rejects.toThrow(code('claim_transition'));
    await expect(
      kit.db.transaction((tx) => kit.expenses.claims.post(draft, 999, accountant(), tx)),
    ).rejects.toThrow(code('version_conflict'));
  });

  it('ignores a repeated approval event and events for other documents', async () => {
    const id = await kit.approved();
    const before = await kit.entries();
    await kit.db.transaction((tx) =>
      kit.expenses.claims.onApprovalOutcome('approved', { docId: id }, tx),
    );
    expect(await kit.entries()).toHaveLength(before.length);
    await kit.db.transaction((tx) =>
      kit.expenses.claims.onApprovalOutcome('approved', { docId: kit.actor.userId }, tx),
    );
    await kit.db.transaction((tx) =>
      kit.platform.events.publish(
        { type: 'approval.approved', payload: { docType: 'variation', docId: id } },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect((await get(id)).status).toBe('approved');
  });
});

describe('rejection, return and withdrawal (BR-7)', () => {
  it('posts nothing for a rejected claim and ends it', async () => {
    const before = (await kit.entries()).length;
    const id = await kit.draft();
    await kit.submit(id);
    await kit.decide(id, 'reject');
    expect((await get(id)).status).toBe('rejected');
    expect(await kit.entries()).toHaveLength(before);
    await expect(update(id)).rejects.toThrow(code('claim_read_only'));
    await expect(submit(id)).rejects.toThrow(code('claim_transition'));
  });

  it('lets the claimant correct and resubmit a returned claim', async () => {
    const before = (await kit.entries()).length;
    const id = await kit.draft();
    await kit.submit(id);
    await kit.decide(id, 'return');
    expect((await get(id)).status).toBe('returned');
    expect(await kit.entries()).toHaveLength(before);
    const edited = await update(id, { lines: [kit.line({ amount: '99.00' })] });
    expect(edited.total).toBe('99.00');
    await submit(id);
    await kit.decide(id, 'approve');
    expect((await get(id)).status).toBe('approved');
  });

  it('returns a claim whose approval request was withdrawn by someone else', async () => {
    const id = await kit.draft();
    await kit.submit(id);
    await kit.db.transaction((tx) =>
      kit.approvals.cancelApproval(
        {
          docType: 'expense_claim',
          docId: id,
          reason: 'Withdrawn by an administrator',
          actorUserId: MANAGEMENT,
          requestId: null,
        },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect((await get(id)).status).toBe('returned');
  });
});

describe('cancel and reverse (BR-7)', () => {
  it('cancels a draft, a returned claim and a submitted claim (withdrawing the request)', async () => {
    const draft = await kit.draft();
    expect(await cancel(draft)).toMatchObject({ status: 'cancelled', cancelReason: null });

    const submitted = await kit.draft();
    await kit.submit(submitted);
    expect(await cancel(submitted, PM, ' changed my mind ')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'changed my mind',
    });
    expect((await get(submitted)).approval.status).toBe('cancelled');
    await kit.platform.events.dispatchDue(kit.db);
    expect((await get(submitted)).status).toBe('cancelled');

    const returned = await kit.draft();
    await kit.submit(returned);
    await kit.decide(returned, 'return');
    expect((await cancel(returned)).status).toBe('cancelled');
  });

  it('reverses the cost entries of an approved claim that is cancelled, leaving nothing', async () => {
    const before = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
    const id = await kit.approved({ lines: [kit.line({ amount: '700.00' })] });
    await cancel(id, PM, 'Duplicate of a paper voucher');
    const after = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
    expect(after.totals).toEqual(before.totals);
    const entries = await kit.entries();
    expect(entries.filter((e) => e.status === 'reversed').length).toBeGreaterThan(0);
    expect((await get(id)).cancelReason).toBe('Duplicate of a paper voucher');
  });

  it('lets the accountant cancel someone else’s approved claim but nobody else', async () => {
    const id = await kit.approved();
    await expect(cancel(id, MANAGEMENT)).rejects.toThrow(code('not_your_claim'));
    await expect(cancel(id, SUPERVISOR)).rejects.toThrow(code('claim_not_found'));
    expect((await cancel(id, ACCOUNTANT)).status).toBe('cancelled');
  });

  it('refuses to cancel a posted claim and reverses it with a reason instead', async () => {
    const summaryBefore = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
    const id = await kit.posted({ lines: [kit.line({ amount: '321.00' })] });
    await expect(cancel(id, ACCOUNTANT)).rejects.toThrow(code('claim_posted'));
    await expect(reverse(id, '  ')).rejects.toThrow(code('reason_required'));
    const reversed = await reverse(id, 'Posted to the wrong month');
    expect(reversed).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Posted to the wrong month',
    });
    const summaryAfter = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
    expect(summaryAfter.totals).toEqual(summaryBefore.totals);
    await expect(reverse(id)).rejects.toThrow(code('claim_not_posted'));
  });

  it('refuses to reverse a claim that is not posted and a stale version', async () => {
    const id = await kit.approved();
    await expect(reverse(id)).rejects.toThrow(code('claim_not_posted'));
    await expect(
      kit.db.transaction((tx) => kit.expenses.claims.reverse(id, 'x', 999, accountant(), tx)),
    ).rejects.toThrow(code('version_conflict'));
    await expect(cancel(id, PM)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(cancel(id, PM)).rejects.toThrow(code('claim_transition'));
  });
});

describe('lines (BR-2)', () => {
  it('rejects an unknown category and an inactive cost code', async () => {
    await expect(create({ lines: [kit.line({ category: 'unknown' })] })).rejects.toThrow(
      code('category_unknown'),
    );
    await expect(create({ lines: [kit.line({ costCodeId: kit.inactiveCode })] })).rejects.toThrow(
      code('cost_code_inactive'),
    );
  });

  it('rejects future dates and dates older than the backdating allowance', async () => {
    await expect(create({ lines: [kit.line({ expenseDate: '2026-10-26' })] })).rejects.toThrow(
      code('date_in_future'),
    );
    await expect(create({ lines: [kit.line({ expenseDate: '2026-10-21' })] })).rejects.toThrow(
      code('backdating_not_allowed'),
    );
    await expect(
      create({
        lines: [kit.line({ expenseDate: '2026-10-25' }), kit.line({ expenseDate: '2026-10-22' })],
      }),
    ).resolves.toMatchObject({ status: 'draft' });
  });

  it('rejects a project line on a project that is not active', async () => {
    const planning = await kit.db.transaction((tx) =>
      kit.projects.service.create(
        {
          name: 'Not started',
          partyId: kit.clientId,
          sector: 'private',
          originalContractValue: '1000',
        },
        kit.actor,
        tx,
      ),
    );
    await expect(
      create({ lines: [kit.line({ costObjectType: 'project', costObjectId: planning.id })] }),
    ).rejects.toThrow(code('project_not_active'));
  });

  it('limits a supervisor to the projects assigned to them (T-6)', async () => {
    const line = kit.line({ costObjectType: 'project', costObjectId: projectId });
    await expect(create({ lines: [line] }, SUPERVISOR)).rejects.toThrow(code('project_not_found'));
    await kit.assignSupervisor(projectId, SUPERVISOR);
    const scoped = kit.actorFor(SUPERVISOR, [{ type: 'project', id: projectId }]);
    const made = await kit.db.transaction((tx) =>
      kit.expenses.claims.create(kit.input({ lines: [line] }), scoped, tx),
    );
    expect(made.status).toBe('draft');
    // Office roles reach any project; an overhead line needs no project at all.
    await expect(create({ lines: [line] }, PM)).resolves.toMatchObject({ status: 'draft' });
    await expect(create({}, SUPERVISOR2)).resolves.toMatchObject({ status: 'draft' });
  });

  it('refuses a project that does not exist and a bad line', async () => {
    await expect(
      create({
        lines: [
          kit.line({
            costObjectType: 'project',
            costObjectId: '018f0000-0000-7000-8000-000000000999',
          }),
        ],
      }),
    ).rejects.toThrow(code('project_not_found'));
    await expect(create({ lines: [] })).rejects.toThrow(code('lines_required'));
  });
});

describe('receipts (BR-3, T-2)', () => {
  it('asks for a receipt above the threshold only', async () => {
    await kit.category('fuel', { receiptRequired: true, maxWithoutReceipt: '500' });
    const at = await kit.draft({ lines: [kit.line({ category: 'fuel', amount: '500.00' })] });
    await expect(submit(at)).resolves.toMatchObject({ status: 'submitted' });

    const over = await kit.draft({ lines: [kit.line({ category: 'fuel', amount: '500.01' })] });
    await expect(submit(over)).rejects.toThrow(code('receipt_required'));

    const receipt = await kit.attachReceipt(over);
    await update(over, {
      lines: [kit.line({ category: 'fuel', amount: '500.01', receiptFileId: receipt })],
    });
    await expect(submit(over)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('accepts only receipts attached to the same claim', async () => {
    await kit.category('fuel', { receiptRequired: true, maxWithoutReceipt: '500' });
    const other = await kit.draft();
    const foreign = await kit.attachReceipt(other);
    const line = kit.line({ category: 'fuel', amount: '900.00', receiptFileId: foreign });
    await expect(create({ lines: [line] })).rejects.toThrow(code('receipt_unknown'));
    const id = await kit.draft({ lines: [kit.line({ category: 'fuel', amount: '900.00' })] });
    await expect(update(id, { lines: [line] })).rejects.toThrow(code('receipt_unknown'));
  });
});

describe('editing and deleting (BR-4)', () => {
  it('lets only the claimant change a draft', async () => {
    const id = await kit.draft();
    await expect(update(id, {}, ACCOUNTANT)).rejects.toThrow(code('not_your_claim'));
    await expect(update(id, {}, SUPERVISOR)).rejects.toThrow(code('claim_not_found'));
    await expect(update(id, {}, PM, 999)).rejects.toThrow(code('version_conflict'));
    const changed = await update(id, {
      note: '  ',
      lines: [kit.line({ amount: '10' }), kit.line({ amount: '5.5' })],
    });
    expect(changed).toMatchObject({ total: '15.50', note: '' });
    expect(changed.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    await submit(id);
    await expect(update(id)).rejects.toThrow(code('claim_read_only'));
  });

  it('deletes a draft only, and only for the claimant', async () => {
    const id = await kit.draft();
    const version = (await get(id)).version;
    await expect(
      kit.db.transaction((tx) =>
        kit.expenses.claims.remove(id, version, kit.actorFor(ACCOUNTANT), tx),
      ),
    ).rejects.toThrow(code('not_your_claim'));
    await expect(
      kit.db.transaction((tx) => kit.expenses.claims.remove(id, 999, kit.actor, tx)),
    ).rejects.toThrow(code('version_conflict'));
    await kit.db.transaction((tx) => kit.expenses.claims.remove(id, version, kit.actor, tx));
    await expect(get(id)).rejects.toThrow(code('claim_not_found'));

    const submitted = await kit.draft();
    await kit.submit(submitted);
    const submittedVersion = await versionOf(submitted);
    await expect(
      kit.db.transaction((tx) =>
        kit.expenses.claims.remove(submitted, submittedVersion, kit.actor, tx),
      ),
    ).rejects.toThrow(code('claim_not_draft'));
  });

  it('refuses to submit someone else’s claim or a claim twice', async () => {
    const id = await kit.draft();
    await expect(submit(id, ACCOUNTANT)).rejects.toThrow(code('not_your_claim'));
    await submit(id);
    await expect(submit(id)).rejects.toThrow(code('claim_transition'));
  });
});

describe('duplicate guard (BR-9, T-5)', () => {
  it('warns about a repeat of an earlier claim until it is acknowledged', async () => {
    const line = kit.line({ amount: '1234.00', expenseDate: '2026-10-24' });
    const first = await kit.draft({ lines: [line] }, STOREKEEPER);
    await kit.submit(first, STOREKEEPER);

    const second = await kit.draft(
      { lines: [kit.line({ amount: '1234.00', expenseDate: '2026-10-22' })] },
      STOREKEEPER,
    );
    const dto = await get(second, STOREKEEPER);
    expect(dto.duplicates).toEqual([
      { lineNo: 1, matchedClaimNumber: (await get(first, STOREKEEPER)).number, matchedLineNo: 1 },
    ]);
    await expect(submit(second, STOREKEEPER)).rejects.toThrow(code('duplicate_expense_warning'));
    await expect(submit(second, STOREKEEPER, true)).resolves.toMatchObject({ status: 'submitted' });
    expect((await get(second, STOREKEEPER)).duplicates).toEqual([]);
  });

  it('does not compare with another claimant or with a cancelled claim', async () => {
    const line = kit.line({ amount: '4321.00' });
    const other = await kit.draft({ lines: [line] }, PM);
    const mine = await kit.draft({ lines: [line] }, STOREKEEPER);
    expect((await get(mine, STOREKEEPER)).duplicates).toEqual([]);
    await cancel(other);
    const later = await kit.draft({ lines: [line] }, PM);
    expect((await get(later)).duplicates).toEqual([]);
  });

  it('finds a repeat inside one claim', async () => {
    const id = await kit.draft({
      lines: [kit.line({ amount: '77.00' }), kit.line({ amount: '77.00' })],
    });
    expect((await get(id)).duplicates).toEqual([
      { lineNo: 2, matchedClaimNumber: null, matchedLineNo: 1 },
    ]);
  });
});

describe('reading', () => {
  it('shows a claimant their own claims and finance every claim', async () => {
    const mine = await kit.draft({}, STOREKEEPER);
    await expect(get(mine, PM)).rejects.toThrow(code('claim_not_found'));
    expect((await get(mine, STOREKEEPER)).id).toBe(mine);
    expect((await get(mine, MANAGEMENT)).id).toBe(mine);

    const own = await kit.expenses.claims.list(
      kit.db,
      { mine: false, limit: 200, offset: 0 },
      kit.actorFor(STOREKEEPER),
    );
    expect(own.items.every((c) => c.claimantId === STOREKEEPER)).toBe(true);
    const all = await kit.expenses.claims.list(
      kit.db,
      { mine: false, limit: 200, offset: 0 },
      accountant(),
    );
    expect(all.items.some((c) => c.claimantId === PM)).toBe(true);
    expect(all.items.some((c) => c.claimantId === STOREKEEPER)).toBe(true);
    const onlyMine = await kit.expenses.claims.list(
      kit.db,
      { mine: true, status: 'draft', limit: 200, offset: 0 },
      kit.actorFor(MANAGEMENT),
    );
    expect(onlyMine.items).toEqual([]);
    expect(onlyMine.total).toBe(0);
  });

  it('reports the claimant of a claim for the receipt access rule', async () => {
    const id = (await create({ note: undefined })).id;
    expect((await get(id)).note).toBe('');
    expect(await kit.expenses.claims.claimantOf(kit.db, id)).toBe(PM);
    expect(await kit.expenses.claims.claimantOf(kit.db, STOREKEEPER)).toBeUndefined();
  });
});

describe('cost entries and reversal (T-4, T-7)', () => {
  it('books one entry per line, once, and the sum equals the claim total', async () => {
    const inCents = (text: string) => Math.round(Number(text) * 100);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 4 }),
        async (cents) => {
          const amounts = cents.map((c) => (c / 100).toFixed(2));
          const before = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
          const id = await kit.draft({
            lines: amounts.map((amount, i) => kit.line({ amount, description: `line ${i}` })),
          });
          // Random amounts can repeat; the warning is acknowledged.
          await kit.submit(id, PM, true);
          await kit.decide(id, 'approve');
          const claim = await get(id);
          const total = (cents.reduce((s, c) => s + c, 0) / 100).toFixed(2);
          expect(claim.total).toBe(total);
          expect(claim.status).toBe('approved');

          const mid = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
          expect(inCents(mid.totals.approved) - inCents(before.totals.approved)).toBe(
            cents.reduce((s, c) => s + c, 0),
          );

          // A replay of the approval does not book anything again.
          await kit.db.transaction((tx) =>
            kit.expenses.claims.onApprovalOutcome('approved', { docId: id }, tx),
          );
          const replay = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
          expect(replay.totals).toEqual(mid.totals);

          await cancel(id, PM, 'property run');
          const after = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
          expect(after.totals).toEqual(before.totals);
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);

  it('reverses posted entries so the project cost nets to zero', async () => {
    const line = kit.line({ costObjectType: 'project', costObjectId: projectId, amount: '800.00' });
    const before = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    const id = await kit.posted({ lines: [line, { ...line, amount: '200.00' }] });
    const mid = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    expect(Number(mid.totals.posted) - Number(before.totals.posted)).toBe(1000);
    await reverse(id);
    const after = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    expect(after.totals).toEqual(before.totals);
  });
});
