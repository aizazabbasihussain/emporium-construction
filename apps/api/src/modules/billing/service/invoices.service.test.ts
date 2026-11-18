import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FBR_RATE,
  PRA_RATE,
  auditCount,
  createBillingKit,
  eventCount,
  type BillingKit,
} from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

const NUMBER = /^INV-2026-(\d{4})$/;
const seq = (number: string | null) => Number((NUMBER.exec(number ?? '') as RegExpExecArray)[1]);

const submit = (id: string, version: number) =>
  kit.tx((tx) => kit.billing.invoices.submit(id, version, kit.actor, tx));
const issue = (id: string, version: number) =>
  kit.tx((tx) => kit.billing.invoices.issue(id, version, kit.actor, tx));
const cancel = (id: string, version: number) =>
  kit.tx((tx) => kit.billing.invoices.cancel(id, version, kit.actor, tx));

describe('worked invoices (T-2, AC-1)', () => {
  it('bills stage 1 (30% of 5,000,000) with tax on the base: 1,500,000 + 150,000', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    expect(invoice).toMatchObject({
      status: 'issued',
      sourceType: 'project_stage',
      baseAmount: '1500000.00',
      advanceRecovery: '0.00',
      taxableBase: '1500000.00',
      taxTotal: '150000.00',
      grossTotal: '1650000.00',
      withholdingExpected: '0.00',
      authorityCode: 'FBR',
      registrationNumber: 'TEST-FBR-0001',
      dueDate: '2026-12-18',
    });
    expect(invoice.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        description: 'Stage 1: Mobilization',
        amount: '1500000.00',
      }),
    ]);
    expect(
      (invoice.taxSnapshot as { taxLines: { ratePercent: string }[] }).taxLines[0]?.ratePercent,
    ).toBe(`${FBR_RATE}.0000`);
    expect((await kit.schedule(project.id)).stages.map((s) => s.status)).toEqual([
      'invoiced',
      'planned',
      'planned',
    ]);
  });

  it('proportional advance recovery of 500,000: tax charged at receipt means a deduction line', async () => {
    const project = await kit.project();
    await kit.receivedAdvance(project.id, '500000');
    const invoice = await kit.issued(project.id, [1]);
    expect(invoice).toMatchObject({
      baseAmount: '1500000.00',
      advanceRecovery: '150000.00',
      taxableBase: '1500000.00',
      taxTotal: '150000.00',
      grossTotal: '1500000.00',
      taxOnAdvanceAtReceipt: true,
    });
    const advances = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    expect(advances[0]).toMatchObject({ applied: '150000.00', status: 'received' });
  });

  it('when tax was not charged at receipt the recovery reduces the taxable base', async () => {
    await kit.setting('billing.tax_on_advance_at_receipt', false);
    try {
      const project = await kit.project();
      await kit.receivedAdvance(project.id, '500000');
      const invoice = await kit.issued(project.id, [1]);
      expect(invoice).toMatchObject({
        advanceRecovery: '150000.00',
        taxableBase: '1350000.00',
        taxTotal: '135000.00',
        grossTotal: '1485000.00',
        taxOnAdvanceAtReceipt: false,
      });
    } finally {
      await kit.setting('billing.tax_on_advance_at_receipt', true);
    }
  });

  it('the fixed-percent method recovers a share of each base (8% of 1,500,000)', async () => {
    await kit.setting('billing.advance_recovery_method', 'fixed_percent');
    await kit.setting('billing.advance_fixed_percent', '8');
    try {
      const project = await kit.project();
      await kit.receivedAdvance(project.id, '500000');
      const invoice = await kit.issued(project.id, [1]);
      expect(invoice.advanceRecovery).toBe('120000.00');
      expect(invoice.grossTotal).toBe('1530000.00');
    } finally {
      await kit.setting('billing.advance_recovery_method', 'proportional');
      await kit.setting('billing.advance_fixed_percent', '0');
    }
  });

  it('when prices include tax the invoice states the net base and the tax inside the stage amount', async () => {
    await kit.db.query("update tax_settings set value = 'true' where key = 'prices_include_tax'");
    try {
      const project = await kit.project();
      const invoice = await kit.issued(project.id, [1]);
      // 1,500,000 gross at 10% = 1,363,636.36 net + 136,363.64 tax.
      expect(invoice).toMatchObject({
        baseAmount: '1500000.00',
        taxableBase: '1363636.36',
        taxTotal: '136363.64',
        grossTotal: '1500000.00',
      });
    } finally {
      await kit.db.query(
        "update tax_settings set value = 'false' where key = 'prices_include_tax'",
      );
    }
  });

  it('applies the recovery to the oldest advance first and moves on when it is full', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.receivedAdvance(project.id, '1000');
    await kit.receivedAdvance(project.id, '100000');
    await kit.issued(project.id, [1]);
    await kit.issued(project.id, [2]);
    const [oldest, newest] = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    // Recoveries 30,300 and 40,400: 1,000 fills the oldest, the rest goes to the newer advance.
    expect([oldest?.applied, oldest?.status]).toEqual(['1000.00', 'fully_applied']);
    expect([newest?.applied, newest?.status]).toEqual(['69700.00', 'received']);
  });

  it('an advance that is only requested, not received, is not recovered', async () => {
    const project = await kit.project();
    await kit.tx((tx) =>
      kit.billing.advances.request(
        { projectId: project.id, amount: '500000', invoiceDate: '2026-11-18' },
        kit.actor,
        tx,
      ),
    );
    const draft = await kit.draft(project.id, [1]);
    const figures = await kit.billing.invoices.preview(kit.db, draft.id, kit.actor);
    expect(figures.advanceRecovery).toBe('0.00');
  });

  it('the last stage takes back what is left of the advance, and the advance is fully applied', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.receivedAdvance(project.id, '100000');
    for (const stage of [1, 2, 3]) await kit.issued(project.id, [stage]);
    const invoices = await kit.billing.listInvoicesForProject(kit.db, project.id);
    const stageInvoices = invoices.filter((i) => i.sourceType !== 'advance');
    expect(stageInvoices.map((i) => i.advanceRecovery).sort()).toEqual([
      '30000.00',
      '30000.00',
      '40000.00',
    ]);
    const advance = (await kit.billing.advances.list(kit.db, project.id, kit.actor))[0];
    expect(advance).toMatchObject({ applied: '100000.00', status: 'fully_applied' });
    const summary = await kit.billing.advances.summary(kit.db, project.id, kit.actor);
    expect(summary).toMatchObject({
      contractValue: '1000000.00',
      netBilled: '1000000.00',
      remainingToBill: '0.00',
      unappliedAdvance: '0.00',
      plannedStages: '0.00',
    });
    expect(await kit.billing.getBilledAmount(kit.db, project.id)).toBe('1000000.00');
  });

  it('expects the withholding the client will deduct from the withholding rules (BR-4)', async () => {
    const rule = await kit.tx((tx) =>
      kit.tax.rules.requestWithholdingRule(
        {
          direction: 'client_withholds',
          authorityCode: 'FBR',
          nature: 'civil',
          ratePercent: '8',
          base: 'on_base',
          effectiveFrom: '2026-01-01',
        },
        { userId: kit.actor.userId, requestId: null },
        tx,
      ),
    );
    await kit.decide('tax_rule', rule.id, 'approve');
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1], { nature: 'civil' });
    expect(invoice.withholdingExpected).toBe('120000.00');
  });
});

describe('authority and registration (AC-2)', () => {
  it('Islamabad is taxed by FBR and Punjab by PRA, each with its registration number', async () => {
    const islamabad = await kit.issued((await kit.project({ where: 'islamabad' })).id, [1]);
    const lahore = await kit.issued((await kit.project({ where: 'lahore' })).id, [1]);
    expect([islamabad.authorityCode, islamabad.registrationNumber, islamabad.taxTotal]).toEqual([
      'FBR',
      'TEST-FBR-0001',
      '150000.00',
    ]);
    expect([lahore.authorityCode, lahore.registrationNumber, lahore.taxTotal]).toEqual([
      'PRA',
      'TEST-PRA-0001',
      '240000.00',
    ]);
    expect(PRA_RATE).toBe('16');
  });

  it('numbers from the series of the authority when it exists, else the shared one', async () => {
    await kit.tx((tx) =>
      kit.platform.numbering.save(
        {
          code: 'invoice_pra',
          prefix: 'PRA',
          padding: 4,
          resetYearly: true,
          gapless: true,
          startValue: 1,
        },
        { actorUserId: kit.actor.userId, requestId: null },
        tx,
      ),
    );
    const lahore = await kit.issued((await kit.project({ where: 'lahore' })).id, [1]);
    const islamabad = await kit.issued((await kit.project({ where: 'islamabad' })).id, [1]);
    expect(lahore).toMatchObject({ seriesCode: 'invoice_pra', number: 'PRA-2026-0001' });
    expect(islamabad.seriesCode).toBe('invoice');
    expect(islamabad.number).toMatch(NUMBER);
  });
});

describe('numbering at issue only (T-4, BR-5)', () => {
  it('a draft, a submitted and an approved invoice have no number; issue takes the next one', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    expect(draft.number).toBeNull();
    const pending = await submit(draft.id, draft.version);
    expect(pending.number).toBeNull();
    await kit.decide('invoice', draft.id, 'approve');
    const approved = await kit.get(draft.id);
    expect(approved).toMatchObject({ status: 'approved', number: null });
    const first = await issue(approved.id, approved.version);
    const second = await kit.issued(project.id, [2]);
    expect(seq(second.number)).toBe(seq(first.number) + 1);
  });

  it('a cancelled draft never used a number, so the next invoice gets the next free one', async () => {
    const project = await kit.project();
    const before = await kit.issued(project.id, [1]);
    const draft = await kit.draft(project.id, [2]);
    await cancel(draft.id, draft.version);
    const after = await kit.issued(project.id, [3]);
    expect(seq(after.number)).toBe(seq(before.number) + 1);
  });
});

describe('invoice state machine and approval (T-5, BR-6)', () => {
  it('goes draft, pending, approved, issued and emits invoice.issued once', async () => {
    const project = await kit.project();
    const issuedBefore = await eventCount(kit.db, 'invoice.issued');
    const draft = await kit.draft(project.id, [1]);
    expect(draft.status).toBe('draft');
    const pending = await submit(draft.id, draft.version);
    expect(pending).toMatchObject({ status: 'pending_approval', grossTotal: '1650000.00' });
    expect(pending.approval.status).toBe('pending');
    await kit.decide('invoice', draft.id, 'approve');
    const approved = await kit.get(draft.id);
    expect(approved.status).toBe('approved');
    const done = await issue(approved.id, approved.version);
    expect(done.status).toBe('issued');
    expect(await eventCount(kit.db, 'invoice.issued')).toBe(issuedBefore + 1);
    expect(await auditCount(kit.db, 'billing.invoice.issue')).toBeGreaterThan(0);
    // A replay of the approval event changes nothing.
    await kit.tx((tx) =>
      kit.billing.invoices.onApprovalOutcome('approved', { docId: draft.id }, tx),
    );
    expect((await kit.get(draft.id)).status).toBe('issued');
  });

  it('cannot be issued before the owner approved it', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    await expect(issue(draft.id, draft.version)).rejects.toThrow('cannot go from draft to issued');
    const pending = await submit(draft.id, draft.version);
    await expect(issue(pending.id, pending.version)).rejects.toThrow('pending_approval to issued');
  });

  it('goes back to draft when the owner refuses or returns it, and can be submitted again', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    await submit(draft.id, draft.version);
    await kit.decide('invoice', draft.id, 'reject');
    const back = await kit.get(draft.id);
    expect(back.status).toBe('draft');
    await submit(back.id, back.version);
    await kit.decide('invoice', draft.id, 'return');
    expect((await kit.get(draft.id)).status).toBe('draft');
  });

  it('locks the invoice after issue: no edit, no cancel, no second submit', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    await expect(
      kit.tx((tx) =>
        kit.billing.invoices.update(
          invoice.id,
          { scheduleIds: [], invoiceDate: '2026-11-19' },
          invoice.version,
          kit.actor,
          tx,
        ),
      ),
    ).rejects.toThrow('correct it with a credit note');
    await expect(cancel(invoice.id, invoice.version)).rejects.toThrow('only by a credit note');
    await expect(submit(invoice.id, invoice.version)).rejects.toThrow('cannot go from issued');
  });

  it('refuses a stale version with a conflict', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    await expect(submit(draft.id, draft.version + 5)).rejects.toThrow('changed by someone else');
  });

  it('refuses issuing when the figures changed since approval (a new advance arrived)', async () => {
    const project = await kit.project();
    const approved = await kit.approved(project.id, [1]);
    await kit.receivedAdvance(project.id, '500000');
    await expect(issue(approved.id, approved.version)).rejects.toThrow('figures changed');
  });

  it('cancels a draft, and a pending invoice together with its approval request', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    expect((await cancel(draft.id, draft.version)).status).toBe('cancelled');
    const other = await kit.draft(project.id, [1]);
    const pending = await submit(other.id, other.version);
    const cancelled = await cancel(pending.id, pending.version);
    expect(cancelled.status).toBe('cancelled');
    expect((await kit.get(other.id)).approval.status).toBe('cancelled');
    // The stage is free again.
    expect((await kit.draft(project.id, [1])).status).toBe('draft');
  });
});

describe('contract value and stages (BR-2, BR-7)', () => {
  it('refuses a stage that is invoiced, on another live invoice, listed twice, missing or absent', async () => {
    const project = await kit.project();
    const schedule = await kit.schedule(project.id);
    const first = schedule.stages[0]?.id as string;
    const create = (scheduleIds: string[]) =>
      kit.tx((tx) =>
        kit.billing.invoices.create(
          project.id,
          { scheduleIds, invoiceDate: '2026-11-18' },
          kit.actor,
          tx,
        ),
      );
    await kit.draft(project.id, [1]);
    await expect(create([first])).rejects.toThrow('already invoiced');
    await expect(create([])).rejects.toThrow('at least one stage');
    await expect(create([first, first])).rejects.toThrow('listed twice');
    await expect(create(['018f7c7c-0000-7000-8000-00000000ffff'])).rejects.toThrow('not found');
  });

  it('refuses invoicing above the contract value, counting advances (BR-7)', async () => {
    const project = await kit.project({ value: '1000000' });
    // An issued advance of 600,000 that is never received cannot be recovered.
    const { invoice } = await kit.tx((tx) =>
      kit.billing.advances.request(
        { projectId: project.id, amount: '600000', invoiceDate: '2026-11-18' },
        kit.actor,
        tx,
      ),
    );
    await submit(invoice.id, invoice.version);
    await kit.decide('invoice', invoice.id, 'approve');
    const approvedAdvance = await kit.get(invoice.id);
    await issue(approvedAdvance.id, approvedAdvance.version);
    await kit.issued(project.id, [1]);
    const stage2 = await kit.draft(project.id, [2]);
    await expect(submit(stage2.id, stage2.version)).rejects.toThrow('exceed the contract value');
  });

  it('refuses a submit while the schedule does not add up to the contract value', async () => {
    const project = await kit.project({ quotation: false });
    const { invoice } = await kit.tx((tx) =>
      kit.billing.advances.request(
        { projectId: project.id, amount: '1000', invoiceDate: '2026-11-18' },
        kit.actor,
        tx,
      ),
    );
    await expect(submit(invoice.id, invoice.version)).rejects.toThrow('adds up to 0.00');
  });

  it('refuses billing a project that is closed', async () => {
    const project = await kit.project();
    const detail = await kit.projects.service.get(kit.db, project.id, kit.actor);
    await kit.tx((tx) =>
      kit.projects.service.transition(
        project.id,
        'cancelled',
        detail.version,
        kit.actor as never,
        tx,
      ),
    );
    await expect(kit.draft(project.id, [1])).rejects.toThrow('cancelled project cannot be billed');
  });
});

describe('tax unavailable blocks issuing (T-7)', () => {
  it('names the missing location, rule or mapping', async () => {
    const noLocation = await kit.project({ where: 'none' });
    const draft = await kit.draft(noLocation.id, [1]);
    await expect(submit(draft.id, draft.version)).rejects.toThrow('has no location');
    await expect(kit.billing.invoices.preview(kit.db, draft.id, kit.actor)).rejects.toThrow(
      'tax authority cannot be resolved',
    );
    const goods = await kit.project();
    const goodsDraft = await kit.draft(goods.id, [1], { supplyKind: 'goods' });
    await expect(submit(goodsDraft.id, goodsDraft.version)).rejects.toThrow();
    // The draft is still a draft and nothing was numbered.
    expect(await kit.get(goodsDraft.id)).toMatchObject({ status: 'draft', number: null });
  });
});

describe('editing a draft (BR-6)', () => {
  it('changes the stages, date and payment terms, and frees the stages it drops', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    const schedule = await kit.schedule(project.id);
    const ids = (nos: number[]) =>
      nos.map((no) => schedule.stages.find((s) => s.stageNo === no)?.id as string);
    const updated = await kit.tx((tx) =>
      kit.billing.invoices.update(
        draft.id,
        {
          scheduleIds: ids([1, 2]),
          invoiceDate: '2026-11-20',
          paymentDays: 15,
          notes: ' first two stages ',
        },
        draft.version,
        kit.actor,
        tx,
      ),
    );
    expect(updated).toMatchObject({
      baseAmount: '3500000.00',
      invoiceDate: '2026-11-20',
      dueDate: '2026-12-05',
      paymentDays: 15,
      notes: 'first two stages',
    });
    expect(updated.lines).toHaveLength(2);
    // Stage 2 is on this draft, so a second invoice cannot take it; stage 3 is free.
    await expect(kit.draft(project.id, [2])).rejects.toThrow('already invoiced');
    expect((await kit.draft(project.id, [3])).status).toBe('draft');
  });

  it('changes only the date, terms and notes of an advance invoice', async () => {
    const project = await kit.project();
    const { invoice } = await kit.tx((tx) =>
      kit.billing.advances.request(
        { projectId: project.id, amount: '1000', invoiceDate: '2026-11-18', notes: 'mobilization' },
        kit.actor,
        tx,
      ),
    );
    const updated = await kit.tx((tx) =>
      kit.billing.invoices.update(
        invoice.id,
        { scheduleIds: [], invoiceDate: '2026-11-19' },
        invoice.version,
        kit.actor,
        tx,
      ),
    );
    expect(updated).toMatchObject({
      sourceType: 'advance',
      baseAmount: '1000.00',
      invoiceDate: '2026-11-19',
      dueDate: '2026-12-19',
      notes: null,
    });
    expect(updated.lines).toHaveLength(1);
  });

  it('bills a variation stage as a variation invoice', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.approvedVariation(project.id, '250000');
    const invoice = await kit.draft(project.id, [4]);
    expect(invoice).toMatchObject({ sourceType: 'variation', baseAmount: '250000.00' });
  });
});

describe('reading invoices', () => {
  it('lists, filters, pages and gets invoices with the module interfaces', async () => {
    const project = await kit.project();
    const first = await kit.issued(project.id, [1]);
    await kit.draft(project.id, [2]);
    const all = await kit.billing.invoices.list(
      kit.db,
      { projectId: project.id, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(all.total).toBe(2);
    const issuedOnly = await kit.billing.invoices.list(
      kit.db,
      { projectId: project.id, status: 'issued', limit: 1, offset: 0 },
      kit.actor,
    );
    expect(issuedOnly.items.map((i) => i.id)).toEqual([first.id]);
    expect(
      (await kit.billing.invoices.list(kit.db, { limit: 500, offset: 0 }, kit.actor)).total,
    ).toBeGreaterThan(1);
    expect((await kit.billing.getInvoice(kit.db, first.id)).number).toBe(first.number);
    expect(await kit.billing.listInvoicesForProject(kit.db, project.id)).toHaveLength(2);
  });

  it('hides a project from a user who cannot reach it, and reports a missing invoice as not found', async () => {
    const project = await kit.project();
    const invoice = await kit.draft(project.id, [1]);
    await expect(kit.billing.invoices.get(kit.db, invoice.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
    await expect(
      kit.billing.invoices.list(
        kit.db,
        { projectId: project.id, limit: 5, offset: 0 },
        kit.outsider,
      ),
    ).rejects.toThrow('Not found');
    await expect(kit.billing.invoices.preview(kit.db, invoice.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
    await expect(
      kit.billing.invoices.get(kit.db, '018f7c7c-0000-7000-8000-00000000ffff', kit.actor),
    ).rejects.toThrow('Not found');
    await expect(
      kit.tx((tx) =>
        kit.billing.invoices.create(
          project.id,
          { scheduleIds: [], invoiceDate: '2026-11-18' },
          kit.outsider,
          tx,
        ),
      ),
    ).rejects.toThrow('Not found');
  });
});

describe('invoice sources are pluggable (BR-12)', () => {
  it('uses a registered provider, and refuses an unknown or duplicate source', async () => {
    const project = await kit.project();
    kit.billing.registerInvoiceSource('extra_work', {
      buildLines: async () => ({
        sourceType: 'project_stage',
        lines: [
          {
            scheduleId: null,
            description: 'Extra work',
            amount: '1000',
            supplyKind: 'services',
            nature: null,
          },
        ],
      }),
    });
    const draft = await kit.tx((tx) =>
      kit.billing.invoices.create(
        project.id,
        { source: 'extra_work', scheduleIds: [], invoiceDate: '2026-11-18' },
        kit.actor,
        tx,
      ),
    );
    expect(draft).toMatchObject({ baseAmount: '1000.00', sourceType: 'project_stage' });
    expect(() =>
      kit.billing.registerInvoiceSource('extra_work', {
        buildLines: async () => ({ sourceType: 'advance', lines: [] }),
      }),
    ).toThrow('already registered');
    await expect(
      kit.tx((tx) =>
        kit.billing.invoices.create(
          project.id,
          { source: 'nope', scheduleIds: [], invoiceDate: '2026-11-18' },
          kit.actor,
          tx,
        ),
      ),
    ).rejects.toThrow('Unknown invoice source nope');
  });
});

describe('print model (T-8, BR-11)', () => {
  it('shows the registration of the authority for an Islamabad and a Punjab invoice, and no internal data', async () => {
    const a = await kit.issued((await kit.project({ where: 'islamabad' })).id, [1], {
      notes: 'INTERNAL-NOTE',
    });
    const b = await kit.issued((await kit.project({ where: 'lahore' })).id, [1]);
    const modelA = await kit.billing.invoices.printModel(kit.db, a.id);
    const modelB = await kit.billing.invoices.printModel(kit.db, b.id);
    expect(modelA.registration).toEqual({
      authority: 'FBR',
      registrationType: 'strn',
      number: 'TEST-FBR-0001',
    });
    expect(modelB.registration).toEqual({
      authority: 'PRA',
      registrationType: 'pra',
      number: 'TEST-PRA-0001',
    });
    expect(modelA.taxLines.map((t) => t.ratePercent)).toEqual([`${FBR_RATE}.0000`]);
    expect(modelB.taxLines.map((t) => t.ratePercent)).toEqual([`${PRA_RATE}.0000`]);
    expect(modelA).toMatchObject({
      company: { name: 'Synthetic Builders', address: 'Office 1, Islamabad' },
      client: { name: 'Synthetic Client', ntn: 'TESTNTN1', city: 'Lahore' },
      baseAmount: '1500000.00',
      taxTotal: '150000.00',
      grossTotal: '1650000.00',
      advanceNote: null,
      withholdingNote: null,
      taxNote: null,
    });
    expect(JSON.stringify(modelA)).not.toContain('INTERNAL-NOTE');
    expect(Object.keys(modelA).sort()).toEqual([
      'advanceNote',
      'advanceRecovery',
      'baseAmount',
      'client',
      'company',
      'grossTotal',
      'invoice',
      'lines',
      'paymentInstructions',
      'registration',
      'taxLines',
      'taxNote',
      'taxTotal',
      'taxableBase',
      'withholdingNote',
    ]);
  });

  it('prints a draft without registration, and the payment instructions setting', async () => {
    await kit.setting('billing.payment_instructions', 'Account title: Synthetic Builders');
    try {
      const project = await kit.project();
      const draft = await kit.draft(project.id, [1]);
      const model = await kit.billing.invoices.printModel(kit.db, draft.id);
      expect(model.registration).toBeNull();
      expect(model.taxNote).toBe('No sales tax is charged on this invoice');
      expect(model.paymentInstructions).toBe('Account title: Synthetic Builders');
      expect(model.invoice.number).toBeNull();
    } finally {
      await kit.setting('billing.payment_instructions', '');
    }
  });
});
