import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { line, seedMasters, tx, wallTemplate, type Fixture } from '../fixtures.js';
import {
  auditCount,
  createEstimationKit,
  eventCount,
  type EstimationKit,
} from '../test-support.js';
import type { EstimateInput, FromTemplateInput } from './estimates.service.js';

let kit: EstimationKit;
let fixture: Fixture;
let templateId: string;
const estimates = () => kit.estimation.estimates;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const input = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  title: 'Test estimate',
  workType: 'boundary_wall',
  sector: 'private',
  lines: [line(kit)],
  ...over,
});
const create = (over: Partial<EstimateInput> = {}) =>
  tx(kit, (t) => estimates().create(input(over), kit.actor, t));
const fromTemplate = (over: Partial<FromTemplateInput> = {}) =>
  tx(kit, (t) =>
    estimates().createFromTemplate(
      {
        templateId,
        title: 'Wall for client',
        sector: 'private',
        parameterValues: { length: '100', height: '6' },
        ...over,
      },
      kit.actor,
      t,
    ),
  );
const lockIt = (id: string, version: number) =>
  tx(kit, (t) => estimates().lock(id, version, kit.actor, t));
/** A priced draft that can be locked. */
const lockable = () => create({ lines: [line(kit, { quantity: '10', rate: '100' })] });

beforeAll(async () => {
  kit = await createEstimationKit();
  fixture = await seedMasters(kit);
  templateId = (
    await tx(kit, (t) => kit.estimation.templates.create(wallTemplate(kit, fixture), kit.actor, t))
  ).id;
}, 60_000);
afterAll(() => kit.close());

describe('creating an estimate from a template (BR-2, BR-3, AC-1)', () => {
  it('evaluates the formulas and prices the lines from vendor prices, template defaults, else missing', async () => {
    const estimate = await fromTemplate();
    expect(estimate).toMatchObject({
      revision: 1,
      status: 'draft',
      workType: 'boundary_wall',
      templateId,
      parameterValues: { length: '100', height: '6' },
      overheadPercent: '10.0000',
      contingencyPercent: '5.0000',
      targetMarginPercent: '15.0000',
      proposedPrice: null,
    });
    expect(estimate.number).toMatch(/^EST-\d{4}$/);
    // 100 x 6 = 600 sqft: 8100 bricks, 120 bags, 12 labour days.
    expect(
      estimate.lines.map((l) => [l.description, l.quantity, l.rate, l.lineTotal, l.rateMissing]),
    ).toEqual([
      ['Bricks', '8100.0000', '20.0000', '162000.00', false],
      // Today is 2026-10-25: the vendor price valid from 2026-07-01 wins over the older and the future one.
      ['Cement', '120.0000', '1250.0000', '150000.00', false],
      ['Mason and helper', '12.0000', '0.0000', '0.00', true],
    ]);
    expect(await auditCount(kit.db, 'estimation.estimate.create')).toBeGreaterThanOrEqual(1);
    expect(await eventCount(kit.db, 'estimation.estimate.changed')).toBeGreaterThanOrEqual(1);
  });

  it('matches the hand-calculated totals once the labour is priced', async () => {
    const draft = await fromTemplate({ proposedPrice: '500000' });
    const lines = draft.lines.map((l) => (l.rateMissing ? { ...l, rate: '2500' } : l));
    const priced = await tx(kit, (t) =>
      estimates().update(
        draft.id,
        { ...draft, workType: draft.workType, lines },
        draft.version,
        kit.actor,
        t,
      ),
    );
    const { totals, rateMissingCount } = await estimates().summary(kit.db, priced.id);
    // 162000 + 150000 + 30000 = 342000; overhead 34200; contingency 17100; total cost 393300.
    expect(rateMissingCount).toBe(0);
    expect(totals).toMatchObject({
      companyCost: '342000.00',
      overheadAmount: '34200.00',
      contingencyAmount: '17100.00',
      totalCost: '393300.00',
      proposedPrice: '500000.00',
      expectedMargin: '106700.00',
      marginPercent: '21.3400',
      meetsTarget: true,
    });
  });

  it('uses the template default when the item has no price in force, and zero without either', async () => {
    kit.now.current = new Date('2025-06-01T10:00:00Z');
    try {
      const estimate = await fromTemplate();
      expect(estimate.lines[1]).toMatchObject({ rate: '1000.0000' });
    } finally {
      kit.now.current = new Date('2026-10-25T10:00:00Z');
    }
  });

  it('refuses a missing, switched-off or mismatching template or bad parameters', async () => {
    await expect(fromTemplate({ templateId: MISSING })).rejects.toMatchObject({
      code: 'template_not_found',
    });
    await expect(fromTemplate({ parameterValues: { length: '1' } })).rejects.toMatchObject({
      code: 'parameter_missing',
    });
    await expect(
      fromTemplate({ parameterValues: { length: 'x', height: '1' } }),
    ).rejects.toMatchObject({ code: 'parameter_invalid' });
    await expect(fromTemplate({ title: ' ' })).rejects.toMatchObject({ code: 'title_required' });
    const off = await tx(kit, (t) =>
      kit.estimation.templates.create(
        { ...wallTemplate(kit, fixture, 'OFF'), active: false },
        kit.actor,
        t,
      ),
    );
    await expect(fromTemplate({ templateId: off.id })).rejects.toMatchObject({
      code: 'template_inactive',
    });
  });

  it('lets the estimate override the work type; the salvage rule follows the estimate (BR-9)', async () => {
    const demolition = await tx(kit, (t) =>
      kit.estimation.templates.create(
        {
          ...wallTemplate(kit, fixture, 'SALV'),
          workType: 'demolition',
          lines: [
            {
              ...line(kit),
              lineKind: 'salvage_credit',
              costCodeId: kit.costCodes.overhead,
              qtyFormula: 'length',
              defaultRate: '10',
            },
          ],
        },
        kit.actor,
        t,
      ),
    );
    const ok = await fromTemplate({ templateId: demolition.id });
    expect(ok.workType).toBe('demolition');
    await expect(
      fromTemplate({ templateId: demolition.id, workType: 'room' }),
    ).rejects.toMatchObject({ code: 'salvage_not_allowed' });
  });
});

describe('creating and editing a draft', () => {
  it('creates a blank estimate with the default percentages from the settings', async () => {
    await tx(kit, (t) =>
      kit.platform.settings.set(
        { key: 'estimation.overhead_percent', value: '12.5', expectedVersion: 0 },
        { actorUserId: kit.actor.userId, requestId: null },
        t,
      ),
    );
    const estimate = await create({ lines: [], partyId: fixture.partyId });
    expect(estimate).toMatchObject({
      overheadPercent: '12.5000',
      contingencyPercent: '5.0000',
      partyId: fixture.partyId,
      lines: [],
    });
    const own = await create({
      overheadPercent: '8',
      contingencyPercent: '2.5',
      targetMarginPercent: '20',
      proposedPrice: '1234.5',
      leadId: MISSING,
    });
    expect(own).toMatchObject({
      overheadPercent: '8.0000',
      contingencyPercent: '2.5000',
      targetMarginPercent: '20.0000',
      proposedPrice: '1234.50',
      leadId: MISSING,
    });
  });

  it('rejects a bad header, percentages, price or line', async () => {
    await expect(create({ title: ' ' })).rejects.toMatchObject({ code: 'title_required' });
    await expect(create({ workType: 'castle' })).rejects.toMatchObject({
      code: 'invalid_work_type',
    });
    await expect(create({ sector: 'alien' })).rejects.toMatchObject({ code: 'invalid_sector' });
    await expect(create({ partyId: MISSING })).rejects.toMatchObject({ code: 'unknown_party' });
    await expect(create({ overheadPercent: 'x' })).rejects.toMatchObject({
      code: 'invalid_overhead_percent',
    });
    await expect(create({ targetMarginPercent: '100' })).rejects.toMatchObject({
      code: 'invalid_target_margin_percent',
    });
    await expect(create({ proposedPrice: '1.234' })).rejects.toMatchObject({
      code: 'invalid_proposed_price',
    });
    await expect(create({ lines: [line(kit, { quantity: '-1' })] })).rejects.toMatchObject({
      code: 'invalid_quantity',
    });
    await expect(create({ lines: [line(kit, { rate: '1.00001' })] })).rejects.toMatchObject({
      code: 'invalid_rate',
    });
    await expect(
      create({
        lines: [line(kit, { lineKind: 'salvage_credit', costCodeId: kit.costCodes.overhead })],
      }),
    ).rejects.toMatchObject({ code: 'salvage_not_allowed' });
    await expect(
      create({ lines: [line(kit, { costCodeId: kit.costCodes.labour })] }),
    ).rejects.toMatchObject({ code: 'cost_code_kind_mismatch' });
  });

  it('updates a draft: header, price and lines, with a version check', async () => {
    const draft = await create();
    const updated = await tx(kit, (t) =>
      estimates().update(
        draft.id,
        input({
          title: 'Changed',
          proposedPrice: '9999',
          lines: [line(kit, { note: ' check rate ', quantity: '2.5', rate: '3.25' }), line(kit)],
        }),
        draft.version,
        kit.actor,
        t,
      ),
    );
    expect(updated).toMatchObject({
      title: 'Changed',
      proposedPrice: '9999.00',
      version: draft.version + 1,
    });
    expect(updated.lines.map((l) => [l.lineNo, l.note, l.lineTotal])).toEqual([
      [1, 'check rate', '8.13'],
      [2, null, '50.00'],
    ]);
    await expect(
      tx(kit, (t) => estimates().update(draft.id, input(), draft.version, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      tx(kit, (t) => estimates().update(MISSING, input(), 1, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'estimate_not_found' });
  });

  it('removes a draft only', async () => {
    const draft = await create();
    await expect(
      tx(kit, (t) => estimates().remove(draft.id, draft.version + 3, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await tx(kit, (t) => estimates().remove(draft.id, draft.version, kit.actor, t));
    await expect(estimates().get(kit.db, draft.id)).rejects.toMatchObject({
      code: 'estimate_not_found',
    });
    await expect(
      tx(kit, (t) => estimates().remove(draft.id, draft.version, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'estimate_not_found' });
    const locked = await lockIt((await lockable()).id, 1);
    await expect(
      tx(kit, (t) => estimates().remove(locked.id, locked.version, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'estimate_locked' });
  });
});

describe('locking, revising and superseding (BR-3, BR-8, AC-3)', () => {
  it('refuses to lock while a company line has no rate, but not for client lines', async () => {
    const draft = await create({
      lines: [line(kit, { rate: '0' }), line(kit, { rate: '100' })],
    });
    await expect(lockIt(draft.id, draft.version)).rejects.toMatchObject({ code: 'rate_missing' });
    const clientOnly = await create({
      lines: [line(kit, { rate: '0', suppliedBy: 'client' }), line(kit, { rate: '100' })],
    });
    const locked = await lockIt(clientOnly.id, clientOnly.version);
    expect(locked.status).toBe('locked');
  });

  it('freezes the totals and makes the estimate read-only', async () => {
    const draft = await create({
      proposedPrice: '2000',
      lines: [
        line(kit, { quantity: '10', rate: '100' }),
        line(kit, { quantity: '1', rate: '50', suppliedBy: 'client' }),
      ],
    });
    const locked = await lockIt(draft.id, draft.version);
    expect(locked).toMatchObject({ status: 'locked', version: draft.version + 1 });
    expect(locked.lockedAt).toBe('2026-10-25T10:00:00.000Z');
    const summary = await estimates().summary(kit.db, locked.id);
    expect(summary.totals).toMatchObject({
      companyCost: '1000.00',
      clientSuppliedValue: '50.00',
      // Overhead is 12.5% here: an earlier test changed the setting.
      totalCost: '1175.00',
      expectedMargin: '825.00',
    });
    expect(await auditCount(kit.db, 'estimation.estimate.lock')).toBeGreaterThanOrEqual(1);
    expect(await eventCount(kit.db, 'estimate.locked')).toBeGreaterThanOrEqual(1);
    const [event] = await kit.db.query<{
      payload: { estimateId: string; totals: { totalCost: string } };
    }>(
      `select payload from sys_outbox where type = 'estimate.locked' and payload->>'estimateId' = $1`,
      [locked.id],
    );
    expect(event?.payload.totals.totalCost).toBe('1175.00');

    await expect(
      tx(kit, (t) => estimates().update(locked.id, input(), locked.version, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'estimate_locked' });
    await expect(lockIt(locked.id, locked.version)).rejects.toMatchObject({
      code: 'estimate_transition',
    });
  });

  it('checks the version when locking', async () => {
    const draft = await create();
    await expect(lockIt(draft.id, draft.version + 1)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(lockIt(MISSING, 1)).rejects.toMatchObject({ code: 'estimate_not_found' });
  });

  it('locks the current version through the module interface', async () => {
    const draft = await lockable();
    const locked = await tx(kit, (t) => kit.estimation.lockEstimate(draft.id, kit.actor, t));
    expect(locked.status).toBe('locked');
    await expect(
      tx(kit, (t) => kit.estimation.lockEstimate(MISSING, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'estimate_not_found' });
  });

  it('revises a locked estimate into version 2 and supersedes version 1 when it locks', async () => {
    const first = await lockIt((await lockable()).id, 1);
    const revision = await tx(kit, (t) => estimates().revise(first.id, kit.actor, t));
    expect(revision).toMatchObject({
      number: first.number,
      revision: 2,
      status: 'draft',
      parentEstimateId: first.id,
      title: first.title,
    });
    expect(revision.lines.map((l) => l.lineTotal)).toEqual(first.lines.map((l) => l.lineTotal));
    expect(revision.id).not.toBe(first.id);

    await expect(tx(kit, (t) => estimates().revise(first.id, kit.actor, t))).rejects.toMatchObject({
      code: 'revision_open',
    });
    // The old version stays locked until the revision locks.
    expect((await estimates().get(kit.db, first.id)).status).toBe('locked');

    const edited = await tx(kit, (t) =>
      estimates().update(
        revision.id,
        input({ lines: [line(kit, { quantity: '20', rate: '100' })] }),
        revision.version,
        kit.actor,
        t,
      ),
    );
    const lockedRevision = await lockIt(edited.id, edited.version);
    expect(lockedRevision).toMatchObject({ revision: 2, status: 'locked' });
    expect((await estimates().get(kit.db, first.id)).status).toBe('superseded');
    // The superseded version keeps its frozen totals.
    expect((await estimates().summary(kit.db, first.id)).totals.companyCost).toBe('1000.00');
    expect((await estimates().summary(kit.db, lockedRevision.id)).totals.companyCost).toBe(
      '2000.00',
    );

    await expect(tx(kit, (t) => estimates().revise(first.id, kit.actor, t))).rejects.toMatchObject({
      code: 'estimate_not_locked',
    });
    const third = await tx(kit, (t) => estimates().revise(lockedRevision.id, kit.actor, t));
    expect(third.revision).toBe(3);
    expect(await auditCount(kit.db, 'estimation.estimate.supersede')).toBeGreaterThanOrEqual(1);
  });

  it('cannot revise a draft', async () => {
    const draft = await create();
    await expect(tx(kit, (t) => estimates().revise(draft.id, kit.actor, t))).rejects.toMatchObject({
      code: 'estimate_not_locked',
    });
    await expect(tx(kit, (t) => estimates().revise(MISSING, kit.actor, t))).rejects.toMatchObject({
      code: 'estimate_not_found',
    });
  });
});

describe('cost lines for the budget (BR-5)', () => {
  it('lists only the company lines of a locked estimate, salvage as negative', async () => {
    const draft = await create({
      workType: 'demolition',
      lines: [
        line(kit, {
          description: 'Debris removal',
          lineKind: 'disposal',
          costCodeId: kit.costCodes.subcontract,
          quantity: '1',
          rate: '1000',
        }),
        line(kit, {
          description: 'Scrap steel',
          lineKind: 'salvage_credit',
          costCodeId: kit.costCodes.overhead,
          quantity: '1',
          rate: '300',
        }),
        line(kit, { description: 'Client bricks', suppliedBy: 'client' }),
      ],
    });
    await expect(kit.estimation.getEstimateCostLines(kit.db, draft.id)).rejects.toMatchObject({
      code: 'estimate_not_locked',
    });
    await lockIt(draft.id, draft.version);
    const lines = await kit.estimation.getEstimateCostLines(kit.db, draft.id);
    expect(lines.map((l) => [l.description, l.amount, l.costCodeId])).toEqual([
      ['Debris removal', '1000.00', kit.costCodes.subcontract],
      ['Scrap steel', '-300.00', kit.costCodes.overhead],
    ]);
    await expect(kit.estimation.getEstimateCostLines(kit.db, MISSING)).rejects.toMatchObject({
      code: 'estimate_not_found',
    });
  });
});

describe('summary, preview and listing', () => {
  it('computes live totals for a draft, and for unsaved lines (preview)', async () => {
    const draft = await create({
      proposedPrice: '0',
      lines: [line(kit, { quantity: '2', rate: '50' }), line(kit, { rate: '0' })],
    });
    const summary = await estimates().summary(kit.db, draft.id);
    expect(summary.rateMissingCount).toBe(1);
    expect(summary.totals).toMatchObject({ companyCost: '100.00', marginPercent: null });
    expect(summary.estimate.id).toBe(draft.id);

    const preview = await estimates().preview(kit.db, {
      proposedPrice: '200',
      lines: [
        { lineKind: 'material', quantity: '2', rate: '50' },
        { lineKind: 'salvage_credit', quantity: '1', rate: '10', suppliedBy: 'company' },
        { lineKind: 'labour', quantity: '1', rate: '0' },
        { lineKind: 'labour', quantity: '1', rate: '0', suppliedBy: 'client' },
      ],
    });
    expect(preview.rateMissingCount).toBe(1);
    expect(preview.totals).toMatchObject({
      companyCost: '90.00',
      totalCost: '105.75',
      expectedMargin: '94.25',
    });
    await expect(
      estimates().preview(kit.db, { lines: [{ lineKind: 'gold', quantity: '1', rate: '1' }] }),
    ).rejects.toMatchObject({ code: 'invalid_line_kind' });
    await expect(
      estimates().preview(kit.db, {
        lines: [{ lineKind: 'labour', quantity: '1', rate: '1', suppliedBy: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_supplied_by' });
    await expect(estimates().summary(kit.db, MISSING)).rejects.toMatchObject({
      code: 'estimate_not_found',
    });
  });

  it('rejects a stored setting that is not a number', async () => {
    await tx(kit, (t) =>
      kit.platform.settings.set(
        { key: 'estimation.contingency_percent', value: 'lots', expectedVersion: 0 },
        { actorUserId: kit.actor.userId, requestId: null },
        t,
      ),
    );
    await expect(create()).rejects.toMatchObject({ code: 'invalid_contingency_percent' });
    await tx(kit, (t) =>
      kit.platform.settings.set(
        { key: 'estimation.contingency_percent', value: '5', expectedVersion: 1 },
        { actorUserId: kit.actor.userId, requestId: null },
        t,
      ),
    );
  });

  it('lists with search, status, lead and client filters', async () => {
    const mine = await create({
      title: 'Findable Gate',
      leadId: MISSING,
      partyId: fixture.partyId,
    });
    const byQ = await estimates().list(kit.db, { q: 'findable', limit: 50, offset: 0 });
    expect(byQ.items.map((e) => e.id)).toContain(mine.id);
    const byLead = await estimates().list(kit.db, { leadId: MISSING, limit: 50, offset: 0 });
    expect(byLead.items.every((e) => e.leadId === MISSING)).toBe(true);
    const byParty = await estimates().list(kit.db, {
      partyId: fixture.partyId,
      limit: 50,
      offset: 0,
    });
    expect(byParty.items.length).toBeGreaterThan(0);
    const locked = await estimates().list(kit.db, { status: 'locked', limit: 50, offset: 0 });
    expect(locked.items.every((e) => e.status === 'locked')).toBe(true);
    const blank = await estimates().list(kit.db, { q: ' ', limit: 1, offset: 0 });
    expect(blank.items).toHaveLength(1);
  });
});
