import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBillingKit, eventCount, type BillingKit } from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

describe('billing schedule (T-1, BR-1)', () => {
  it('is built from the accepted quotation: percents of the contract value, summing to it (AC-1)', async () => {
    const project = await kit.project({ value: '5000000' });
    const schedule = await kit.schedule(project.id);
    expect(schedule.stages.map((s) => [s.stageNo, s.name, s.amount, s.status, s.source])).toEqual([
      [1, 'Mobilization', '1500000.00', 'planned', 'quotation'],
      [2, 'Structure', '2000000.00', 'planned', 'quotation'],
      [3, 'Handover', '1500000.00', 'planned', 'quotation'],
    ]);
    expect(schedule).toMatchObject({
      originalContractValue: '5000000.00',
      contractValue: '5000000.00',
      scheduleTotal: '5000000.00',
      matchesContract: true,
      pendingEditId: null,
    });
  });

  it('is built once: syncing again changes nothing', async () => {
    const project = await kit.project();
    await kit.tx((tx) => kit.billing.schedule.sync(tx, project.id, kit.actor));
    await kit.tx((tx) => kit.billing.schedule.sync(tx, project.id, kit.actor));
    expect((await kit.schedule(project.id)).stages).toHaveLength(3);
  });

  it('has no stages for a project without a quotation', async () => {
    const project = await kit.project({ quotation: false });
    const schedule = await kit.schedule(project.id);
    expect(schedule.stages).toEqual([]);
    expect(schedule.matchesContract).toBe(false);
  });

  it('adds one stage per approved variation, with its price impact, and keeps the sum equal (BR-1)', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.approvedVariation(project.id, '250000');
    const schedule = await kit.schedule(project.id);
    expect(schedule.stages).toHaveLength(4);
    expect(schedule.stages[3]).toMatchObject({
      stageNo: 4,
      amount: '250000.00',
      source: 'variation',
    });
    expect(schedule.stages[3]?.name).toMatch(/^Variation /);
    expect(schedule).toMatchObject({
      contractValue: '1250000.00',
      scheduleTotal: '1250000.00',
      matchesContract: true,
    });
    // A replay of the event adds nothing.
    await kit.tx((tx) => kit.billing.schedule.sync(tx, project.id, kit.actor));
    expect((await kit.schedule(project.id)).stages).toHaveLength(4);
  });

  it('blocks invoices while the sum differs from the contract value', async () => {
    const project = await kit.project({ quotation: false });
    await expect(kit.billing.schedule.assertReadyToBill(kit.db, project.id)).rejects.toThrow(
      'adds up to 0.00 but the contract value is 5000000.00',
    );
  });

  it('reports the planned total, which drops as stages are invoiced', async () => {
    const project = await kit.project({ value: '1000000' });
    expect(await kit.billing.schedule.plannedTotal(kit.db, project.id)).toBe('1000000.00');
    await kit.issued(project.id, [1]);
    expect(await kit.billing.schedule.plannedTotal(kit.db, project.id)).toBe('700000.00');
  });

  it('refuses a user who cannot reach the project', async () => {
    const project = await kit.project();
    await expect(kit.billing.schedule.get(kit.db, project.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
  });
});

describe('manual schedule edit needs approval (BR-1)', () => {
  const edit = (
    projectId: string,
    stages: Parameters<BillingKit['billing']['schedule']['edit']>[1],
  ) => kit.tx((tx) => kit.billing.schedule.edit(projectId, stages, kit.actor, tx));

  it('replaces the planned stages, blocks invoices until approved, then allows them', async () => {
    const project = await kit.project({ value: '1000000' });
    const before = await kit.schedule(project.id);
    const result = await edit(project.id, [
      { id: before.stages[0]?.id, stageNo: 1, name: 'Mobilization', amount: '400000' },
      { id: before.stages[1]?.id, stageNo: 2, name: 'Structure', amount: '400000' },
      { stageNo: 3, name: 'Handover', amount: '200000' },
    ]);
    expect(result.pendingEditId).not.toBeNull();
    expect(result.stages.map((s) => [s.amount, s.source])).toEqual([
      ['400000.00', 'quotation'],
      ['400000.00', 'quotation'],
      ['200000.00', 'manual'],
    ]);
    await expect(
      kit
        .draft(project.id, [1])
        .then((d) => kit.tx((tx) => kit.billing.invoices.submit(d.id, d.version, kit.actor, tx))),
    ).rejects.toThrow('waiting for approval');
    await expect(edit(project.id, [{ stageNo: 1, name: 'Again', amount: '1' }])).rejects.toThrow(
      'waiting for approval',
    );
    await kit.decide('billing_schedule', result.pendingEditId as string, 'approve');
    const after = await kit.schedule(project.id);
    expect(after.pendingEditId).toBeNull();
    expect(after.stages.map((s) => s.amount)).toEqual(['400000.00', '400000.00', '200000.00']);
    // Delivering the decision again changes nothing.
    await kit.tx((tx) =>
      kit.billing.schedule.onApprovalOutcome(
        'approved',
        { docId: result.pendingEditId as string },
        tx,
      ),
    );
    expect((await kit.schedule(project.id)).stages).toHaveLength(3);
  });

  it('restores the earlier stages when the owner refuses, and ignores unknown ids', async () => {
    const project = await kit.project({ value: '1000000' });
    const before = await kit.schedule(project.id);
    const result = await edit(project.id, [{ stageNo: 1, name: 'Everything', amount: '1000000' }]);
    await kit.decide('billing_schedule', result.pendingEditId as string, 'reject');
    const after = await kit.schedule(project.id);
    expect(after.pendingEditId).toBeNull();
    expect(after.stages.map((s) => [s.id, s.stageNo, s.amount])).toEqual(
      before.stages.map((s) => [s.id, s.stageNo, s.amount]),
    );
    await kit.tx((tx) =>
      kit.billing.schedule.onApprovalOutcome(
        'approved',
        { docId: '018f7c7c-0000-7000-8000-00000000aaaa' },
        tx,
      ),
    );
    expect(await eventCount(kit.db, 'billing.schedule.changed')).toBeGreaterThan(0);
  });

  it('keeps invoiced stages and refuses numbers they use or stages that are on an invoice', async () => {
    const project = await kit.project({ value: '1000000' });
    const draft = await kit.draft(project.id, [1]);
    await expect(edit(project.id, [{ stageNo: 1, name: 'X', amount: '1' }])).rejects.toThrow(
      'cancel that invoice',
    );
    await kit.tx((tx) => kit.billing.invoices.cancel(draft.id, draft.version, kit.actor, tx));
    await kit.issued(project.id, [1]);
    await expect(edit(project.id, [{ stageNo: 1, name: 'X', amount: '700000' }])).rejects.toThrow(
      'already used',
    );
    const ok = await edit(project.id, [
      { stageNo: 2, name: 'Rest A', amount: '350000' },
      { stageNo: 3, name: 'Rest B', amount: '350000' },
    ]);
    expect(ok.stages.map((s) => [s.stageNo, s.status])).toEqual([
      [1, 'invoiced'],
      [2, 'planned'],
      [3, 'planned'],
    ]);
  });

  it('refuses a user who cannot reach the project', async () => {
    const project = await kit.project();
    await expect(
      kit.tx((tx) => kit.billing.schedule.edit(project.id, [], kit.outsider, tx)),
    ).rejects.toThrow('Not found');
  });
});
