import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PM,
  auditCount,
  createProjectsKit,
  eventCount,
  uid,
  type ProjectsKit,
} from '../test-support.js';

let kit: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
}, 120_000);
afterAll(() => kit.close());

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

const tx = <T>(run: (db: ProjectsKit['db']) => Promise<T>) => kit.db.transaction(run);
const summaryOf = (projectId: string) =>
  kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });

describe('postCost (BR-5, T-4)', () => {
  it('posts a cost, returns it again for the same idempotency key, and audits it', async () => {
    const project = await kit.activeProject();
    const before = await auditCount(kit.db, 'projects.cost.post');
    const id = await kit.cost(project.id, { idempotencyKey: 'same-key', description: ' bricks ' });
    const again = await kit.cost(project.id, { idempotencyKey: 'same-key', amount: '999.00' });
    expect(again).toBe(id);
    expect(await auditCount(kit.db, 'projects.cost.post')).toBe(before + 1);
    expect(await eventCount(kit.db, 'projects.cost.changed')).toBeGreaterThan(0);
    const entries = await kit.projects.costing.listEntries(
      kit.db,
      { type: 'project', id: project.id },
      { limit: 10, offset: 0 },
    );
    expect(entries.items[0]).toMatchObject({
      id,
      amount: '100.00',
      status: 'committed',
      description: 'bricks',
      reversesEntryId: null,
      sourceModule: 'procurement',
    });
  });

  it('accepts a planning project and overhead, and a salvage credit', async () => {
    const planning = await kit.project();
    await kit.cost(planning.id);
    await kit.cost(null, { costCodeId: kit.codes['500'] as string });
    const project = await kit.activeProject();
    await kit.cost(project.id, { amount: '-25.50', sourceDocType: 'salvage', sourceLineId: null });
    expect((await summaryOf(project.id)).totals.committed).toBe('-25.50');
  });

  it('refuses a negative amount that is not salvage, a bad amount and blank text', async () => {
    const project = await kit.activeProject();
    expect(await codeOf(() => kit.cost(project.id, { amount: '-1.00' }))).toBe('amount_negative');
    expect(await codeOf(() => kit.cost(project.id, { amount: '1.234' }))).toBe('amount_invalid');
    expect(await codeOf(() => kit.cost(project.id, { sourceModule: ' ' }))).toBe(
      'source_module_required',
    );
    expect(await codeOf(() => kit.cost(project.id, { sourceDocType: ' ' }))).toBe(
      'source_doc_type_required',
    );
    expect(await codeOf(() => kit.cost(project.id, { idempotencyKey: ' ' }))).toBe(
      'idempotency_key_required',
    );
    expect(await codeOf(() => kit.cost(project.id, { entryDate: '2026-13-01' }))).toBeDefined();
  });

  it('refuses a cost object that is missing, closed or of the wrong kind', async () => {
    expect(await codeOf(() => kit.cost(uid(9001)))).toBe('cost_object_not_found');
    const project = await kit.activeProject();
    const held = await tx((db) =>
      kit.projects.service.transition(project.id, 'on_hold', project.version, kit.actorFor(PM), db),
    );
    expect(await codeOf(() => kit.cost(project.id))).toBe('cost_object_not_open');
    void held;
    expect(
      await codeOf(() =>
        tx((db) =>
          kit.projects.postCost(
            {
              costObject: { type: 'overhead', id: project.id },
              costCodeId: kit.codes['100'] as string,
              amount: '1',
              status: 'committed',
              sourceModule: 'm',
              sourceDocType: 't',
              sourceDocId: uid(1),
              entryDate: '2026-10-25',
              idempotencyKey: 'overhead-with-id',
            },
            db,
          ),
        ),
      ),
    ).toBe('overhead_has_no_id');
  });

  it('refuses work orders until the setting is on (BR-11)', async () => {
    const post = (key: string) =>
      tx((db) =>
        kit.projects.postCost(
          {
            costObject: { type: 'work_order', id: uid(5001) },
            costCodeId: kit.codes['100'] as string,
            amount: '10',
            status: 'committed',
            sourceModule: 'm',
            sourceDocType: 't',
            sourceDocId: uid(5002),
            entryDate: '2026-10-25',
            idempotencyKey: key,
          },
          db,
        ),
      );
    expect(await codeOf(() => post('wo-1'))).toBe('work_order_disabled');
    await tx((db) =>
      kit.platform.settings.set(
        { key: 'projects.work_orders_enabled', value: true, expectedVersion: 0 },
        { actorUserId: null, requestId: null },
        db,
      ),
    );
    expect((await post('wo-2')).costObjectType).toBe('work_order');
    await tx((db) =>
      kit.platform.settings.set(
        { key: 'projects.work_orders_enabled', value: false, expectedVersion: 1 },
        { actorUserId: null, requestId: null },
        db,
      ),
    );
  });

  it('refuses an inactive or unknown cost code and a source line that is already live', async () => {
    const project = await kit.activeProject();
    expect(await codeOf(() => kit.cost(project.id, { costCodeId: kit.inactiveCode }))).toBe(
      'cost_code_inactive',
    );
    expect(await codeOf(() => kit.cost(project.id, { costCodeId: uid(9002) }))).toBe(
      'cost_code_not_found',
    );
    const line = { sourceDocId: uid(6001), sourceLineId: uid(6002) };
    const first = await kit.cost(project.id, line);
    expect(await codeOf(() => kit.cost(project.id, line))).toBe('cost_chain_exists');
    await tx((db) => kit.projects.reverseCost(first, 'cancelled order', db));
    // After a reversal the same source line may be posted again.
    await kit.cost(project.id, line);
  });
});

describe('ledger chains (BR-6, BR-7, T-5)', () => {
  it('moves committed to approved to posted to reversed and the summary follows', async () => {
    const project = await kit.activeProject();
    const first = await kit.cost(project.id, { amount: '250.00' });
    const expectTotals = async (c: string, a: string, p: string) =>
      expect((await summaryOf(project.id)).totals).toEqual({
        committed: c,
        approved: a,
        posted: p,
      });
    await expectTotals('250.00', '0.00', '0.00');

    const approved = await tx((db) => kit.projects.transitionCost(first, 'approved', db, PM));
    expect(approved).toMatchObject({ status: 'approved', amount: '250.00', reversesEntryId: null });
    await expectTotals('0.00', '250.00', '0.00');

    const posted = await tx((db) => kit.projects.transitionCost(approved.id, 'posted', db));
    await expectTotals('0.00', '0.00', '250.00');

    const reversed = await tx((db) => kit.projects.reverseCost(posted.id, 'wrong project', db, PM));
    expect(reversed).toMatchObject({
      status: 'reversed',
      reversesEntryId: posted.id,
      description: 'wrong project',
    });
    await expectTotals('0.00', '0.00', '0.00');
    expect(await auditCount(kit.db, 'projects.cost.reverse')).toBeGreaterThan(0);
    expect(await auditCount(kit.db, 'projects.cost.transition')).toBeGreaterThan(0);
  });

  it('repeats a transition without a second row and keeps the description when none is given', async () => {
    const project = await kit.activeProject();
    const first = await kit.cost(project.id, { description: 'cement' });
    const a = await tx((db) => kit.projects.transitionCost(first, 'approved', db));
    const b = await tx((db) => kit.projects.transitionCost(first, 'approved', db));
    expect(b.id).toBe(a.id);
    expect(a.description).toBe('cement');
  });

  it('refuses forbidden moves, superseded rows, unknown entries and a blank reason', async () => {
    const project = await kit.activeProject();
    const first = await kit.cost(project.id);
    expect(await codeOf(() => tx((db) => kit.projects.transitionCost(first, 'posted', db)))).toBe(
      'cost_transition',
    );
    await tx((db) => kit.projects.transitionCost(first, 'approved', db));
    expect(await codeOf(() => tx((db) => kit.projects.transitionCost(first, 'reversed', db)))).toBe(
      'cost_entry_superseded',
    );
    expect(
      await codeOf(() => tx((db) => kit.projects.transitionCost(uid(9003), 'approved', db))),
    ).toBe('cost_entry_not_found');
    expect(await codeOf(() => tx((db) => kit.projects.reverseCost(first, ' ', db)))).toBe(
      'reason_required',
    );
  });

  it('keeps separate source lines separate and sums them by status', async () => {
    const project = await kit.activeProject();
    const a = await kit.cost(project.id, { amount: '10.10' });
    const b = await kit.cost(project.id, { amount: '20.20' });
    await kit.cost(project.id, { amount: '30.30', status: 'posted' });
    await tx((db) => kit.projects.transitionCost(b, 'approved', db));
    await tx((db) => kit.projects.reverseCost(a, 'dup', db));
    expect((await summaryOf(project.id)).totals).toEqual({
      committed: '0.00',
      approved: '20.20',
      posted: '30.30',
    });
  });
});

describe('cost summary and budget variance (BR-8, T-6)', () => {
  it('reports spend against budget per code with the warning threshold', async () => {
    const project = await kit.activeProject();
    await tx((db) =>
      kit.projects.service.replaceBudget(
        project.id,
        [
          { costCodeId: kit.codes['100'] as string, budgetAmount: '1000' },
          { costCodeId: kit.codes['200'] as string, budgetAmount: '500' },
          { costCodeId: kit.codes['300'] as string, budgetAmount: '200' },
        ],
        project.version,
        kit.actorFor(PM),
        db,
      ),
    );
    await kit.cost(project.id, { amount: '400.00' });
    await kit.cost(project.id, { amount: '500.00', status: 'posted' });
    await kit.cost(project.id, { amount: '600.00', costCodeId: kit.codes['200'] as string });
    await kit.cost(project.id, { amount: '1.00', costCodeId: kit.codes['400'] as string });
    const summary = await summaryOf(project.id);
    const line = (code: string) => summary.lines.find((l) => l.costCodeId === kit.codes[code]);
    expect(line('100')).toMatchObject({
      committed: '400.00',
      posted: '500.00',
      budget: '1000.00',
      variance: '100.00',
      flag: 'warning',
    });
    expect(line('200')).toMatchObject({ variance: '-100.00', flag: 'overspent' });
    expect(line('300')).toMatchObject({ committed: '0.00', variance: '200.00', flag: 'ok' });
    expect(line('400')).toMatchObject({ budget: '0.00', variance: '-1.00', flag: 'overspent' });
    expect(summary).toMatchObject({
      budget: '1700.00',
      variance: '199.00',
      flag: 'ok',
      costObjectType: 'project',
    });
  });

  it('honours a changed warning threshold', async () => {
    const project = await kit.activeProject();
    await tx((db) =>
      kit.projects.service.replaceBudget(
        project.id,
        [{ costCodeId: kit.codes['100'] as string, budgetAmount: '1000' }],
        project.version,
        kit.actorFor(PM),
        db,
      ),
    );
    await kit.cost(project.id, { amount: '500.00' });
    expect((await summaryOf(project.id)).flag).toBe('ok');
    await tx((db) =>
      kit.platform.settings.set(
        { key: 'projects.budget_warning_percent', value: 50, expectedVersion: 0 },
        { actorUserId: null, requestId: null },
        db,
      ),
    );
    expect((await summaryOf(project.id)).flag).toBe('warning');
  });

  it('has no budget fields for overhead', async () => {
    await kit.cost(null, { amount: '70.00', costCodeId: kit.codes['500'] as string });
    const summary = await kit.projects.getCostSummary(kit.db, { type: 'overhead', id: null });
    expect(summary).toMatchObject({ budget: null, variance: null, flag: null });
    expect(summary.lines[0]).toMatchObject({ budget: null, variance: null, flag: null });
    expect(Number(summary.totals.committed)).toBeGreaterThanOrEqual(70);
  });

  it('lists entries with filters', async () => {
    const project = await kit.activeProject();
    await kit.cost(project.id);
    const id = await kit.cost(project.id, { costCodeId: kit.codes['200'] as string });
    await tx((db) => kit.projects.transitionCost(id, 'approved', db));
    const list = (query: { status?: 'approved'; costCodeId?: string }) =>
      kit.projects.costing.listEntries(
        kit.db,
        { type: 'project', id: project.id },
        { ...query, limit: 1, offset: 0 },
      );
    expect((await list({})).total).toBe(3);
    expect((await list({})).items).toHaveLength(1);
    expect((await list({ status: 'approved' })).total).toBe(1);
    expect((await list({ costCodeId: kit.codes['200'] })).total).toBe(2);
  });
});
