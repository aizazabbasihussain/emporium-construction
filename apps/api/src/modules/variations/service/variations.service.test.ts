import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGEMENT,
  PM,
  SUPERVISOR,
  auditCount,
  createVariationsKit,
  eventCount,
  type VariationsKit,
} from '../test-support.js';

let kit: VariationsKit;
let paged: VariationsKit;
beforeAll(async () => {
  kit = await createVariationsKit();
  paged = await createVariationsKit({ ledgerPageSize: 2 });
}, 120_000);
afterAll(async () => {
  await kit.close();
  await paged.close();
});

const service = () => kit.variations.service;
const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);
const get = (id: string) => service().get(kit.db, id, kit.actor);
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};
const MISSING = '018f0000-0000-7000-8000-000000000999';
const line = (over: Record<string, string> = {}) => ({
  description: 'Rock breaking',
  costCodeId: kit.codes['100'] as string,
  costAmount: '100.00',
  priceAmount: '150.00',
  ...over,
});
const budgetOf = async (projectId: string) =>
  (await kit.projects.service.getBudget(kit.db, projectId, kit.actorFor(PM))).lines;
const run = async <T>(
  fn: (id: string, version: number, db: typeof kit.db) => Promise<T>,
  id: string,
) => {
  const version = await kit.version(id);
  return tx((db) => fn(id, version, db));
};

describe('create (BR-1, BR-2)', () => {
  it('numbers variations per project from the project code and totals the lines', async () => {
    const project = await kit.project();
    const other = await kit.project();
    const first = await kit.draft(project.id);
    const second = await kit.draft(project.id, {
      lines: [line({ costAmount: '10.5', priceAmount: '20' }), line({ priceAmount: '-5.25' })],
    });
    const otherFirst = await kit.draft(other.id);
    expect((await get(first)).number).toBe(`${project.code}-V1`);
    expect(await get(second)).toMatchObject({
      number: `${project.code}-V2`,
      priceImpact: '14.75',
      costImpact: '110.50',
      status: 'draft',
      projectId: project.id,
      atRiskTotal: '0.00',
      approval: { status: 'none', requestId: null, currentRole: null },
    });
    expect((await get(otherFirst)).number).toBe(`${other.code}-V1`);
    expect((await get(first)).history).toMatchObject([{ fromStatus: null, toStatus: 'draft' }]);
  });

  it('writes an audit entry and an event for each change', async () => {
    const project = await kit.project();
    const audits = await auditCount(kit.db, 'variations.variation.create');
    const events = await eventCount(kit.db, 'variations.variation.changed');
    await kit.draft(project.id);
    expect(await auditCount(kit.db, 'variations.variation.create')).toBe(audits + 1);
    expect(await eventCount(kit.db, 'variations.variation.changed')).toBe(events + 1);
  });

  it('needs an active project (BR-1)', async () => {
    const project = await kit.project();
    const detail = await kit.projects.service.get(kit.db, project.id, kit.actorFor(PM));
    await tx((db) =>
      kit.projects.service.transition(project.id, 'on_hold', detail.version, kit.actorFor(PM), db),
    );
    expect(await codeOf(kit.draft(project.id))).toBe('project_not_active');
    expect(await codeOf(kit.draft(MISSING))).toBe('project_not_found');
  });

  it('needs at least one line, a description, a title and a valid date (BR-2)', async () => {
    const project = await kit.project();
    expect(await codeOf(kit.draft(project.id, { lines: [] }))).toBe('lines_required');
    expect(await codeOf(kit.draft(project.id, { title: '  ' }))).toBe('title_required');
    expect(await codeOf(kit.draft(project.id, { discoveredOn: '2026-02-31' }))).toBe(
      'invalid_date',
    );
    expect(await codeOf(kit.draft(project.id, { lines: [line({ description: '' })] }))).toBe(
      'description_required',
    );
  });

  it('refuses a cost code that is switched off or unknown', async () => {
    const project = await kit.project();
    expect(
      await codeOf(kit.draft(project.id, { lines: [line({ costCodeId: kit.inactiveCode })] })),
    ).toBe('cost_code_inactive');
    expect(await codeOf(kit.draft(project.id, { lines: [line({ costCodeId: MISSING })] }))).toBe(
      'cost_code_not_found',
    );
  });

  it('lets a supervisor create a draft only on an assigned project', async () => {
    const project = await kit.project();
    const supervisor = kit.actorFor(SUPERVISOR, [{ type: 'project', id: project.id }]);
    const created = await tx((db) => service().create(project.id, kit.input(), supervisor, db));
    expect(created.status).toBe('draft');
    expect(
      await codeOf(
        tx((db) => service().create(project.id, kit.input(), kit.actorFor(SUPERVISOR), db)),
      ),
    ).toBe('project_not_found');
  });
});

describe('update and remove (BR-6)', () => {
  it('replaces the lines of a draft and keeps the totals in step', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    const updated = await run(
      (_, version, db) =>
        service().update(
          id,
          kit.input({ title: 'Renamed', reason: undefined, lines: [line({ costAmount: '7' })] }),
          version,
          kit.actor,
          db,
        ),
      id,
    );
    expect(updated).toMatchObject({ title: 'Renamed', reason: '', costImpact: '7.00' });
    expect(updated.lines).toHaveLength(1);
  });

  it('refuses a stale version', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    const version = await kit.version(id);
    expect(
      await codeOf(tx((db) => service().update(id, kit.input(), version + 5, kit.actor, db))),
    ).toBe('version_conflict');
    expect(await codeOf(tx((db) => service().remove(id, version + 5, kit.actor, db)))).toBe(
      'version_conflict',
    );
  });

  it('removes a draft', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await run((_, version, db) => service().remove(id, version, kit.actor, db), id);
    expect(await codeOf(get(id))).toBe('variation_not_found');
    expect(await service().exists(kit.db, id)).toBe(false);
  });

  it('an approved variation cannot be edited, deleted or cancelled (T-6)', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await kit.approved(id);
    const version = await kit.version(id);
    expect(
      await codeOf(tx((db) => service().update(id, kit.input(), version, kit.actor, db))),
    ).toBe('variation_read_only');
    expect(await codeOf(tx((db) => service().remove(id, version, kit.actor, db)))).toBe(
      'variation_read_only',
    );
    expect(await codeOf(tx((db) => service().cancel(id, version, kit.actor, db)))).toBe(
      'variation_transition',
    );
    expect(await get(id)).toMatchObject({ status: 'client_approved', title: 'Extra excavation' });
  });
});

describe('internal approval (BR-3, AC-2)', () => {
  it('submits to the approval engine and records the timeline', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    const dto = await run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id);
    expect(dto.status).toBe('pending_internal_approval');
    expect(dto.approval).toMatchObject({ status: 'pending', currentRole: 'management' });
    expect(dto.history.map((h) => h.toStatus)).toEqual(['draft', 'pending_internal_approval']);
    expect(
      await codeOf(run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id)),
    ).toBe('variation_transition');
  });

  it('submits a deductive variation at the size of its price impact', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id, {
      lines: [line({ costAmount: '0', priceAmount: '-5000' })],
    });
    const dto = await run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id);
    expect(dto.approval.status).toBe('pending');
  });

  it('cannot go to the client without internal approval', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    expect(await codeOf(run((_, v, db) => service().sendToClient(id, v, kit.actor, db), id))).toBe(
      'variation_transition',
    );
    await run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id);
    expect(await codeOf(run((_, v, db) => service().sendToClient(id, v, kit.actor, db), id))).toBe(
      'internal_approval_required',
    );
  });

  it('stays blocked when the approver rejects, and can then be cancelled', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id);
    await kit.decide(id, 'reject');
    expect((await get(id)).status).toBe('pending_internal_approval');
    expect((await get(id)).approval.status).toBe('rejected');
    expect(await codeOf(run((_, v, db) => service().sendToClient(id, v, kit.actor, db), id))).toBe(
      'internal_approval_required',
    );
    const cancelled = await run((_, v, db) => service().cancel(id, v, kit.actor, db), id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('goes to the client once approved', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await kit.sent(id);
    const dto = await get(id);
    expect(dto.status).toBe('submitted_to_client');
    expect(dto.approval.status).toBe('approved');
    expect(dto.history.map((h) => h.toStatus)).toEqual([
      'draft',
      'pending_internal_approval',
      'submitted_to_client',
    ]);
  });
});

describe('client approval (BR-4, BR-5, T-3, T-4)', () => {
  it('needs a reference, a date that is not in the future, and an attached document', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await kit.sent(id);
    const approve = (reference: string, approvedOn: string) =>
      codeOf(
        run(
          (_, v, db) => service().clientApprove(id, { reference, approvedOn }, v, kit.actor, db),
          id,
        ),
      );
    expect(await approve('LTR-1', '2026-10-24')).toBe('client_document_required');
    await kit.attachClientDocument(id);
    expect(await approve('  ', '2026-10-24')).toBe('client_reference_required');
    expect(await approve('LTR-1', '2026-10-26')).toBe('client_date_future');
    expect(await approve('LTR-1', '2026-10-25')).toBeUndefined();
    expect(await get(id)).toMatchObject({
      status: 'client_approved',
      clientApprovalRef: 'LTR-1',
      clientApprovedOn: '2026-10-25',
    });
  });

  it('cannot be approved from a draft or pending state', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    const approve = () =>
      run(
        (_, v, db) =>
          service().clientApprove(
            id,
            { reference: 'X', approvedOn: '2026-10-24' },
            v,
            kit.actor,
            db,
          ),
        id,
      );
    expect(await codeOf(approve())).toBe('variation_transition');
    await kit.internallyApproved(id);
    expect(await codeOf(approve())).toBe('variation_transition');
  });

  it('adds budget lines once, raises the contract value and emits one event', async () => {
    const project = await kit.project();
    const before = (await budgetOf(project.id)).length;
    const events = await eventCount(kit.db, 'variation.approved');
    const id = await kit.draft(project.id, {
      lines: [
        line({ description: 'Rock breaking', costAmount: '100.00', priceAmount: '150.00' }),
        line({ description: 'Rock breaking', costAmount: '40.00', priceAmount: '60.00' }),
        line({ description: 'Goodwill credit', costAmount: '0', priceAmount: '-10' }),
        line({ description: 'Labour', costCodeId: kit.codes['200'] as string, costAmount: '25' }),
      ],
    });
    await kit.approved(id);
    const added = (await budgetOf(project.id)).slice(before);
    const number = (await get(id)).number;
    expect(added.map((b) => [b.description, b.budgetAmount, b.source])).toEqual(
      expect.arrayContaining([
        [`${number} L1: Rock breaking`, '100.00', 'variation'],
        [`${number} L2: Rock breaking`, '40.00', 'variation'],
        [`${number} L4: Labour`, '25.00', 'variation'],
      ]),
    );
    expect(added).toHaveLength(3);
    expect(await eventCount(kit.db, 'variation.approved')).toBe(events + 1);
    // A second attempt is refused and changes nothing (replay safety).
    expect(
      await codeOf(
        run(
          (_, v, db) =>
            service().clientApprove(
              id,
              { reference: 'CLIENT-LTR-1', approvedOn: '2026-10-24' },
              v,
              kit.actor,
              db,
            ),
          id,
        ),
      ),
    ).toBe('variation_transition');
    expect(await budgetOf(project.id)).toHaveLength(before + 3);
    expect(await eventCount(kit.db, 'variation.approved')).toBe(events + 1);
    const payload = await kit.db.query<{ payload: { currentContractValue: string } }>(
      `select payload from sys_outbox where type = 'variation.approved'
        and payload->>'variationId' = $1`,
      [id],
    );
    expect(payload[0]?.payload.currentContractValue).toBe('1000350.00');
  });

  it('computes the contract value from the original and the approved impacts only (AC-1)', async () => {
    const project = await kit.project();
    expect(await service().contractValue(kit.db, project.id)).toEqual({
      projectId: project.id,
      originalContractValue: '1000000.00',
      approvedPriceImpact: '0.00',
      currentContractValue: '1000000.00',
      approvedVariations: 0,
    });
    const a = await kit.draft(project.id, { lines: [line({ priceAmount: '250000.50' })] });
    const b = await kit.draft(project.id, {
      lines: [line({ costAmount: '0', priceAmount: '-100000.25' })],
    });
    const pending = await kit.draft(project.id, { lines: [line({ priceAmount: '999' })] });
    await kit.approved(a);
    await kit.approved(b);
    await kit.internallyApproved(pending);
    expect(await service().contractValue(kit.db, project.id)).toEqual({
      projectId: project.id,
      originalContractValue: '1000000.00',
      approvedPriceImpact: '150000.25',
      currentContractValue: '1150000.25',
      approvedVariations: 2,
    });
    expect(await kit.variations.getCurrentContractValue(kit.db, project.id)).toBe('1150000.25');
    expect(
      (await kit.variations.listApprovedVariations(kit.db, project.id)).map((v) => v.id),
    ).toEqual([a, b]);
    const original = await kit.db.query<{ original_contract_value: string }>(
      'select original_contract_value::text from prj_projects where id = $1',
      [project.id],
    );
    expect(original[0]?.original_contract_value).toBe('1000000.00');
  });

  it('an unknown project has no contract value', async () => {
    expect(await codeOf(service().contractValue(kit.db, MISSING))).toBe('project_not_found');
  });
});

describe('client rejection, cancel and copy (BR-7)', () => {
  it('records the rejection with its reason and emits variation.rejected', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await kit.sent(id);
    const events = await eventCount(kit.db, 'variation.rejected');
    const reject = (reason: string) =>
      run((_, v, db) => service().clientReject(id, reason, v, kit.actor, db), id);
    expect(await codeOf(reject('  '))).toBe('reason_required');
    const dto = await reject('Too expensive');
    expect(dto.status).toBe('client_rejected');
    expect(dto.history.at(-1)).toMatchObject({
      toStatus: 'client_rejected',
      note: 'Too expensive',
    });
    expect(await eventCount(kit.db, 'variation.rejected')).toBe(events + 1);
    expect(await codeOf(reject('again'))).toBe('variation_transition');
    expect(await service().contractValue(kit.db, project.id)).toMatchObject({
      currentContractValue: '1000000.00',
    });
  });

  it('cancels a draft and a submitted variation; cancelled is terminal', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id);
    const sent = await kit.draft(project.id);
    await kit.sent(sent);
    for (const id of [draft, sent]) {
      const dto = await run((_, v, db) => service().cancel(id, v, kit.actor, db), id);
      expect(dto.status).toBe('cancelled');
      expect(await codeOf(run((_, v, db) => service().cancel(id, v, kit.actor, db), id))).toBe(
        'variation_transition',
      );
      expect(await codeOf(tx((db) => service().copy(id, kit.actor, db)))).toBe(
        'variation_not_copyable',
      );
    }
  });

  it('cancelling a pending variation cancels its approval request', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await run((_, v, db) => service().submitInternal(id, v, kit.actor, db), id);
    await run((_, v, db) => service().cancel(id, v, kit.actor, db), id);
    expect((await get(id)).approval.status).toBe('cancelled');
  });

  it('copies a rejected variation into a new draft', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id, {
      reason: undefined,
      lines: [line(), line({ description: 'More', costAmount: '5', priceAmount: '9' })],
    });
    await kit.sent(id);
    await run((_, v, db) => service().clientReject(id, 'No', v, kit.actor, db), id);
    const copy = await tx((db) => service().copy(id, kit.actor, db));
    expect(copy).toMatchObject({
      status: 'draft',
      copiedFromId: id,
      title: 'Extra excavation',
      reason: '',
      priceImpact: '159.00',
      costImpact: '105.00',
    });
    expect(copy.number).toBe(`${project.code}-V2`);
    expect(copy.lines.map((l) => l.description)).toEqual(['Rock breaking', 'More']);
    expect(copy.history[0]?.note).toBe('copied from a rejected variation');
  });

  it('cannot copy a draft, and not onto a project that is no longer active', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id);
    expect(await codeOf(tx((db) => service().copy(draft, kit.actor, db)))).toBe(
      'variation_not_copyable',
    );
    const id = await kit.draft(project.id);
    await kit.sent(id);
    await run((_, v, db) => service().clientReject(id, 'No', v, kit.actor, db), id);
    const detail = await kit.projects.service.get(kit.db, project.id, kit.actorFor(PM));
    await tx((db) =>
      kit.projects.service.transition(project.id, 'on_hold', detail.version, kit.actorFor(PM), db),
    );
    expect(await codeOf(tx((db) => service().copy(id, kit.actor, db)))).toBe('project_not_active');
  });
});

describe('listing and reading', () => {
  it('lists the variations of a project newest first, with a status filter and paging', async () => {
    const project = await kit.project();
    const a = await kit.draft(project.id);
    const b = await kit.draft(project.id);
    await run((_, v, db) => service().cancel(b, v, kit.actor, db), b);
    const all = await service().list(kit.db, project.id, { limit: 50, offset: 0 }, kit.actor);
    expect(all.items.map((v) => v.id)).toEqual([b, a]);
    expect(all.total).toBe(2);
    const cancelled = await service().list(
      kit.db,
      project.id,
      { status: 'cancelled', limit: 50, offset: 0 },
      kit.actor,
    );
    expect(cancelled.items.map((v) => v.id)).toEqual([b]);
    const second = await service().list(kit.db, project.id, { limit: 1, offset: 1 }, kit.actor);
    expect(second).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(second.items.map((v) => v.id)).toEqual([a]);
  });

  it('hides a project a supervisor is not assigned to', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    const outsider = kit.actorFor(SUPERVISOR);
    expect(
      await codeOf(service().list(kit.db, project.id, { limit: 5, offset: 0 }, outsider)),
    ).toBe('project_not_found');
    expect(await codeOf(service().get(kit.db, id, outsider))).toBe('project_not_found');
    expect(await codeOf(tx((db) => service().cancel(id, 1, outsider, db)))).toBe(
      'project_not_found',
    );
    expect(await codeOf(service().get(kit.db, MISSING, kit.actor))).toBe('variation_not_found');
    expect(await codeOf(service().list(kit.db, MISSING, { limit: 5, offset: 0 }, kit.actor))).toBe(
      'project_not_found',
    );
  });
});

describe('costs at risk (BR-8, T-5, AC-3)', () => {
  it('reports costs posted on or after discovery, of the lines cost codes, until approval', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id, {
      discoveredOn: '2026-10-20',
      lines: [line(), line({ costCodeId: kit.codes['200'] as string, description: 'Labour' })],
    });
    await kit.cost(project.id, { amount: '500.00', entryDate: '2026-10-22' });
    await kit.cost(project.id, { amount: '300.25', entryDate: '2026-10-20', status: 'approved' });
    await kit.cost(project.id, {
      amount: '70.00',
      entryDate: '2026-10-21',
      costCodeId: kit.codes['200'] as string,
    });
    // Not at risk: before discovery, other cost code, only committed.
    await kit.cost(project.id, { amount: '1000.00', entryDate: '2026-10-19' });
    await kit.cost(project.id, { amount: '1000.00', costCodeId: kit.codes['500'] as string });
    await kit.cost(project.id, { amount: '1000.00', status: 'committed' });
    const reversed = await kit.cost(project.id, { amount: '1000.00' });
    await tx((db) => kit.projects.reverseCost(reversed, 'Entered by mistake', db, null));

    const dto = await get(id);
    expect(dto.atRiskTotal).toBe('870.25');
    expect(dto.atRisk).toEqual({
      total: '870.25',
      byCostCode: [
        { costCodeId: kit.codes['100'], amount: '800.25' },
        { costCodeId: kit.codes['200'], amount: '70.00' },
      ].sort((x, y) => (x.costCodeId as string).localeCompare(y.costCodeId as string)),
    });
    const listed = await service().list(kit.db, project.id, { limit: 5, offset: 0 }, kit.actor);
    expect(listed.items[0]?.atRiskTotal).toBe('870.25');

    await kit.approved(id);
    expect((await get(id)).atRisk).toEqual({ total: '0.00', byCostCode: [] });
    expect((await get(id)).atRiskTotal).toBe('0.00');
  });

  it('reads a ledger of several pages', async () => {
    const project = await paged.project();
    const id = await paged.draft(project.id, { discoveredOn: '2026-10-01' });
    for (let i = 0; i < 5; i += 1) await paged.cost(project.id, { amount: '10.00' });
    const dto = await paged.variations.service.get(paged.db, id, paged.actor);
    expect(dto.atRiskTotal).toBe('50.00');
  });

  it('reads no ledger when nothing is open', async () => {
    const project = await kit.project();
    const id = await kit.draft(project.id);
    await kit.approved(id);
    const listed = await service().list(kit.db, project.id, { limit: 5, offset: 0 }, kit.actor);
    expect(listed.items[0]?.atRiskTotal).toBe('0.00');
    expect(MANAGEMENT).toBeDefined();
  });
});
