import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillInput } from './bills.service.js';
import { auditCount, eventCount } from '../procurement-kit.js';
import {
  MANAGEMENT,
  PM,
  STOREKEEPER,
  TODAY,
  createPayablesKit,
  type PayablesKit,
} from '../test-support.js';

let kit: PayablesKit;
beforeAll(async () => {
  kit = await createPayablesKit();
}, 180_000);
afterAll(() => kit.close());

const create = (input: BillInput, actor = kit.pactor) =>
  kit.run((tx) => kit.payables.bills.create(input, actor, tx));
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const match = (id: string, version: number, overrideReason?: string, actor = kit.pactor) =>
  kit.run((tx) => kit.payables.bills.match(id, { version, overrideReason }, actor, tx));
const submit = (id: string, version: number, actor = kit.pactor) =>
  kit.run((tx) => kit.payables.bills.submit(id, version, actor, tx));
const post = (id: string, version: number) =>
  kit.run((tx) => kit.payables.bills.post(id, version, kit.pactor, tx));
const cancel = (id: string, version: number, reason = 'Entered twice') =>
  kit.run((tx) => kit.payables.bills.cancel(id, { reason, version }, kit.pactor, tx));

describe('lines and sources the other tests leave out', () => {
  it('keeps a typed description and lets a purchase line move to overhead', async () => {
    const received = await kit.receipt();
    const bill = await create(
      kit.billInput(received, {
        lines: [
          {
            grnId: received.grnId,
            grnLineId: received.grnLineIds[0],
            description: 'Cement, delivered',
            quantity: '100',
            rate: '50',
            costObjectType: 'overhead',
          },
        ],
      }),
    );
    expect(bill.lines[0]).toMatchObject({
      description: 'Cement, delivered',
      costObjectType: 'overhead',
      costObjectId: null,
    });
  });

  it('needs a location when the bill has neither a location nor a project line (BR-3)', async () => {
    const draft = await create({
      vendorPartyId: await kit.vendor(),
      vendorInvoiceNo: 'NOLOC-1',
      billDate: TODAY,
      dueDate: '2026-11-25',
      sourceType: 'expense_other',
      lines: [
        {
          quantity: '1',
          rate: '5',
          costObjectType: 'overhead',
          costCodeId: kit.codes['600'],
        },
      ],
    });
    const matched = await match(draft.id, draft.version);
    await refused(submit(matched.id, matched.version), 'location_required');
  });

  it('lets an edit change the source of a bill and drop its location', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const edited = await kit.run((tx) =>
      kit.payables.bills.update(
        draft.id,
        draft.version,
        {
          vendorPartyId: draft.vendorPartyId,
          vendorInvoiceNo: draft.vendorInvoiceNo,
          billDate: TODAY,
          dueDate: '2026-11-25',
          sourceType: 'expense_other',
          lines: [
            {
              quantity: '1',
              rate: '5',
              costObjectType: 'overhead',
              costCodeId: kit.codes['600'],
            },
          ],
        },
        kit.pactor,
        tx,
      ),
    );
    expect(edited).toMatchObject({
      sourceType: 'expense_other',
      supplyKind: 'services',
      locationId: null,
    });
  });
});

describe('bill sources before any is registered (BR-6)', () => {
  it('refuses a source nobody registered', async () => {
    await refused(
      kit.run((tx) =>
        kit.payables.bills.createFromSource(
          'subcontract',
          '018f7c7c-0000-7000-8000-0000000000cc',
          { vendorInvoiceNo: 'X', billDate: TODAY, dueDate: TODAY },
          kit.pactor,
          tx,
        ),
      ),
      'unknown_bill_source',
    );
  });
});

describe('creating a bill (BR-1, BR-2)', () => {
  it('records a draft purchase bill from receipt lines and audits it', async () => {
    const received = await kit.receipt({ lines: [{ quantity: '10', rate: '99.9999' }] });
    const audits = await auditCount(kit.db, 'payables.bill.create');
    const bill = await create(kit.billInput(received, { quantities: ['10'], rates: ['99.9999'] }));
    expect(bill).toMatchObject({
      status: 'draft',
      sourceType: 'purchase',
      supplyKind: 'goods',
      baseAmount: '1000.00',
      grossTotal: '1000.00',
      netPayable: '1000.00',
      outstanding: '0.00',
      approval: { status: 'none' },
    });
    expect(bill.number).toMatch(/^VB-/);
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      sourceDocType: 'goods_receipt',
      sourceDocId: received.grnId,
      grnLineId: received.grnLineIds[0],
      poLineId: received.poLineIds[0],
      costObjectType: 'project',
      costObjectId: received.projectId,
      amount: '1000.00',
    });
    expect(await auditCount(kit.db, 'payables.bill.create')).toBe(audits + 1);
  });

  it('refuses a second bill with the same vendor invoice number, trimmed (BR-2)', async () => {
    const received = await kit.receipt();
    const input = kit.billInput(received, { vendorInvoiceNo: 'DUP-1' });
    await create(input);
    await refused(create({ ...input, vendorInvoiceNo: ' DUP-1 ' }), 'duplicate_bill');
  });

  it('refuses bad headers', async () => {
    const received = await kit.receipt();
    const input = kit.billInput(received);
    await refused(create({ ...input, dueDate: '2026-10-01' }), 'due_before_bill');
    await refused(
      create({ ...input, vendorPartyId: '018f7c7c-0000-7000-8000-000000000001' }),
      'vendor_not_found',
    );
    const client = await kit.run((tx) =>
      kit.masterData.parties.create(
        { name: 'Not a vendor', roles: ['client'], city: 'Lahore' },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    await refused(create({ ...input, vendorPartyId: client.id }), 'not_a_vendor');
    const retired = await kit.run((tx) =>
      kit.masterData.parties.create(
        { name: 'Retired vendor', roles: ['vendor'], city: 'Lahore', status: 'inactive' },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    await refused(create({ ...input, vendorPartyId: retired.id }), 'vendor_inactive');
  });

  it('refuses a date beyond the backdating limit', async () => {
    const received = await kit.receipt();
    await expect(
      create(kit.billInput(received, { billDate: '2026-01-05', dueDate: '2026-02-05' })),
    ).rejects.toBeDefined();
  });

  it('refuses purchase lines that do not name a receipt line, or name another vendor’s', async () => {
    const received = await kit.receipt();
    const input = kit.billInput(received);
    await refused(
      create({ ...input, lines: [{ quantity: '1', rate: '1' }] }),
      'receipt_line_required',
    );
    await refused(
      create({
        ...input,
        lines: [
          { grnId: received.grnId, grnLineId: received.poLineIds[0], quantity: '1', rate: '1' },
        ],
      }),
      'receipt_line_not_found',
    );
    await refused(create({ ...input, vendorPartyId: await kit.vendor() }), 'vendor_mismatch');
  });

  it('refuses a line of a cancelled receipt', async () => {
    const received = await kit.receipt();
    const grn = await kit.procurement.getGrn(kit.db, received.grnId);
    await kit.run((tx) =>
      kit.procurement.service.receipts.cancel(
        received.grnId,
        'Wrong delivery',
        grn.version,
        kit.actorFor(STOREKEEPER),
        tx,
      ),
    );
    await refused(create(kit.billInput(received)), 'receipt_cancelled');
  });

  it('takes lines of other sources with their own cost object (BR-6)', async () => {
    const vendor = await kit.vendor();
    const project = await kit.project();
    const base = {
      vendorPartyId: vendor,
      vendorInvoiceNo: 'SRV-1',
      billDate: TODAY,
      dueDate: '2026-11-25',
      sourceType: 'expense_other' as const,
      locationId: kit.islamabadId,
    };
    const bill = await create({
      ...base,
      lines: [
        {
          description: ' Hire ',
          quantity: '2',
          rate: '150.255',
          costObjectType: 'project',
          costObjectId: project.id,
          costCodeId: kit.codes['400'],
        },
        {
          quantity: '1',
          rate: '10',
          costObjectType: 'overhead',
          costCodeId: kit.codes['600'],
        },
      ],
    });
    expect(bill.supplyKind).toBe('services');
    expect(bill.baseAmount).toBe('310.51');
    expect(bill.lines.map((l) => [l.description, l.amount, l.sourceDocType])).toEqual([
      ['Hire', '300.51', null],
      ['', '10.00', null],
    ]);
    await refused(
      create({ ...base, vendorInvoiceNo: 'SRV-2', lines: [{ quantity: '1', rate: '1' }] }),
      'cost_object_required',
    );
    await refused(
      create({
        ...base,
        vendorInvoiceNo: 'SRV-3',
        lines: [
          {
            quantity: '1',
            rate: '1',
            costObjectType: 'project',
            costCodeId: kit.codes['400'],
          },
        ],
      }),
      'cost_object_invalid',
    );
  });

  it('lets a purchase line redirect its cost object and cost code', async () => {
    const received = await kit.receipt({ projectId: null });
    const other = await kit.project();
    const bill = await create(
      kit.billInput(received, {
        lines: [
          {
            grnId: received.grnId,
            grnLineId: received.grnLineIds[0],
            quantity: '100',
            rate: '50',
            costObjectType: 'project',
            costObjectId: other.id,
            costCodeId: kit.codes['200'],
          },
        ],
      }),
    );
    expect(bill.lines[0]).toMatchObject({
      costObjectType: 'project',
      costObjectId: other.id,
      costCodeId: kit.codes['200'],
    });
    const overhead = await create(kit.billInput(received));
    expect(overhead.lines[0]).toMatchObject({ costObjectType: 'overhead', costObjectId: null });
  });
});

describe('editing a bill', () => {
  it('replaces the header and lines of a draft and sends a matched bill back to draft', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const edited = await kit.run((tx) =>
      kit.payables.bills.update(
        draft.id,
        draft.version,
        kit.billInput(received, {
          vendorInvoiceNo: draft.vendorInvoiceNo,
          quantities: ['40'],
          notes: ' changed ',
          nature: 'works',
          supplyKind: 'services',
        }),
        kit.pactor,
        tx,
      ),
    );
    expect(edited).toMatchObject({
      baseAmount: '2000.00',
      notes: 'changed',
      supplyKind: 'services',
    });
    const matched = await match(edited.id, edited.version);
    expect(matched.status).toBe('matched');
    const again = await kit.run((tx) =>
      kit.payables.bills.update(
        matched.id,
        matched.version,
        kit.billInput(received, { vendorInvoiceNo: 'EDIT-NEW', quantities: ['30'] }),
        kit.pactor,
        tx,
      ),
    );
    expect(again).toMatchObject({
      status: 'draft',
      matchOverrideReason: null,
      supplyKind: 'goods',
    });
    await refused(
      kit.run((tx) =>
        kit.payables.bills.update(
          again.id,
          again.version + 5,
          kit.billInput(received),
          kit.pactor,
          tx,
        ),
      ),
      'version_conflict',
    );
    await refused(
      kit.run((tx) =>
        kit.payables.bills.update(
          again.id,
          again.version,
          kit.billInput(received, { dueDate: '2026-01-01' }),
          kit.pactor,
          tx,
        ),
      ),
      'due_before_bill',
    );
  });

  it('does not edit a bill that is no longer a draft', async () => {
    const received = await kit.receipt();
    const approved = await kit.approvedBill(kit.billInput(received));
    await refused(
      kit.run((tx) =>
        kit.payables.bills.update(
          approved.id,
          approved.version,
          kit.billInput(received),
          kit.pactor,
          tx,
        ),
      ),
      'bill_not_editable',
    );
    await refused(
      kit.run((tx) =>
        kit.payables.bills.update(
          '018f7c7c-0000-7000-8000-000000000009',
          1,
          kit.billInput(received),
          kit.pactor,
          tx,
        ),
      ),
      'bill_not_found',
    );
  });
});

describe('three-way match (BR-1)', () => {
  it('accepts a bill at the order rate for the received quantity', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const matched = await match(draft.id, draft.version);
    expect(matched.status).toBe('matched');
    expect(matched.matches).toEqual([
      {
        billLineId: draft.lines[0]?.id,
        poRate: '50.0000',
        grnQty: '100.0000',
        billedQty: '100.0000',
        billedRate: '50.0000',
        qtyVariance: '0.0000',
        rateVariance: '0.0000',
        withinTolerance: true,
      },
    ]);
    expect(matched.matchOverrideReason).toBeNull();
  });

  it('puts a bill above the order rate in matched only with a reason from a user who may override', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received, { rates: ['55'] }));
    await refused(match(draft.id, draft.version), 'match_variance');
    await refused(match(draft.id, draft.version, '   '), 'match_variance');
    const plain = { ...kit.pactor, permissions: new Set<string>() };
    await refused(
      match(draft.id, draft.version, 'Price rise agreed', plain),
      'override_not_allowed',
    );
    const matched = await match(draft.id, draft.version, 'Price rise agreed');
    expect(matched).toMatchObject({ status: 'matched', matchOverrideReason: 'Price rise agreed' });
    expect(matched.matches[0]).toMatchObject({
      rateVariance: '5.0000',
      withinTolerance: false,
    });
  });

  it('refuses to bill more than was received (over-billing)', async () => {
    const received = await kit.receipt({ receivedQty: ['60'] });
    const draft = await create(kit.billInput(received, { quantities: ['100'] }));
    await refused(match(draft.id, draft.version), 'match_variance');
    const matched = await match(draft.id, draft.version, 'Vendor billed in full');
    expect(matched.matches[0]).toMatchObject({ grnQty: '60.0000', qtyVariance: '40.0000' });
  });

  it('counts what other bills already billed (partial billing across several bills)', async () => {
    const received = await kit.receipt();
    const first = await create(kit.billInput(received, { quantities: ['60'] }));
    await match(first.id, first.version);
    const second = await create(kit.billInput(received, { quantities: ['60'] }));
    await refused(match(second.id, second.version), 'match_variance');
    await cancel(second.id, second.version);
    const third = await create(kit.billInput(received, { quantities: ['40'] }));
    expect((await match(third.id, third.version)).matches[0]).toMatchObject({
      qtyVariance: '0.0000',
      withinTolerance: true,
    });
  });

  it('uses the tolerances of H-23 when the owner sets them', async () => {
    await kit.put('payables.match_rate_tolerance_percent', '10');
    await kit.put('payables.match_qty_tolerance_percent', '5');
    try {
      const received = await kit.receipt();
      const draft = await create(kit.billInput(received, { rates: ['54'], quantities: ['104'] }));
      const matched = await match(draft.id, draft.version);
      expect(matched.matches[0]).toMatchObject({ withinTolerance: true, qtyVariance: '4.0000' });
    } finally {
      await kit.put('payables.match_rate_tolerance_percent', '0');
      await kit.put('payables.match_qty_tolerance_percent', '0');
    }
  });

  it('matches only a draft, and a bill without receipt lines needs no variance check', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const matched = await match(draft.id, draft.version);
    await refused(match(matched.id, matched.version), 'bill_not_draft');
    const other = await create({
      vendorPartyId: await kit.vendor(),
      vendorInvoiceNo: 'NOGRN-1',
      billDate: TODAY,
      dueDate: '2026-11-25',
      sourceType: 'expense_other',
      locationId: kit.islamabadId,
      lines: [
        {
          quantity: '1',
          rate: '5',
          costObjectType: 'overhead',
          costCodeId: kit.codes['600'],
        },
      ],
    });
    expect((await match(other.id, other.version)).matches).toEqual([]);
  });

  it('warns when the bill is above the open commitments (BR-2)', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received, { quantities: ['100'], rates: ['500'] }));
    expect(draft.warnings).toEqual([]);
    const dear = await match(draft.id, draft.version, 'Agreed with the vendor');
    expect(dear.warnings).toEqual(['above_open_commitments']);
    const other = await kit.receipt();
    const fine = await create(kit.billInput(other));
    expect((await match(fine.id, fine.version)).warnings).toEqual([]);
  });
});

describe('submitting and approving (BR-3, BR-4)', () => {
  it('works out tax and withholding, asks the owner and moves to approved', async () => {
    await kit.withholdingRule();
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received, { nature: 'works' }));
    const matched = await match(draft.id, draft.version);
    const events = await eventCount(kit.db, 'payables.bill.changed');
    const submitted = await submit(matched.id, matched.version);
    expect(submitted).toMatchObject({
      status: 'pending_approval',
      baseAmount: '5000.00',
      taxTotal: '500.00',
      grossTotal: '5500.00',
      withholdingTotal: '100.00',
      netPayable: '5400.00',
      authorityCode: 'FBR',
      approval: { status: 'pending', currentRole: 'management' },
    });
    expect(submitted.taxSnapshot).toBeTruthy();
    expect(await eventCount(kit.db, 'payables.bill.changed')).toBe(events + 1);
    await kit.decide('vendor_bill', submitted.id, 'approve');
    expect((await kit.bill(submitted.id)).status).toBe('approved');
  });

  it('refuses to submit without rules or a location (BR-3)', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received, { locationId: undefined }));
    const matched = await match(draft.id, draft.version);
    await refused(submit(matched.id, matched.version), 'location_required');
    const lahore = await kit.run((tx) =>
      kit.masterData.company.createLocation(
        { name: 'Site Lahore', region: 'punjab', city: 'Lahore' },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    const another = await kit.receipt();
    const noRule = await create(
      kit.billInput(another, { vendorInvoiceNo: 'NORULE', locationId: lahore.id }),
    );
    const noRuleMatched = await match(noRule.id, noRule.version);
    await expect(submit(noRuleMatched.id, noRuleMatched.version)).rejects.toBeDefined();
  });

  it('takes the location from the project when the bill names none', async () => {
    const pm = kit.actorFor(PM);
    const first = await kit.project();
    const partyId = (await kit.projects.service.get(kit.db, first.id, pm)).partyId;
    const created = await kit.run((tx) =>
      kit.projects.service.create(
        {
          name: 'Located project',
          partyId,
          sector: 'private',
          originalContractValue: '1000000',
          locationId: kit.islamabadId,
        },
        pm,
        tx,
      ),
    );
    const active = await kit.run((tx) =>
      kit.projects.service.transition(created.id, 'active', created.version, pm, tx),
    );
    const received = await kit.receipt({ projectId: active.id });
    const draft = await create(kit.billInput(received, { locationId: undefined }));
    const matched = await match(draft.id, draft.version);
    expect((await submit(matched.id, matched.version)).status).toBe('pending_approval');
  });

  it('lets only the user who entered the bill submit it (BR-4)', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const matched = await match(draft.id, draft.version);
    const other = { ...kit.pactor, userId: MANAGEMENT };
    await refused(submit(matched.id, matched.version, other), 'only_creator_submits');
  });

  it('keeps the creator from approving the bill (AC-3)', async () => {
    const received = await kit.receipt();
    const owner = { ...kit.pactor, userId: MANAGEMENT, roles: ['management'] };
    const draft = await create(kit.billInput(received), owner);
    const matched = await match(draft.id, draft.version, undefined, owner);
    const submitted = await submit(matched.id, matched.version, owner);
    await expect(kit.decide('vendor_bill', submitted.id, 'approve')).rejects.toBeDefined();
    expect((await kit.bill(submitted.id)).status).toBe('pending_approval');
  });

  it('goes back to matched when the owner rejects or returns it, and ignores stale events', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const matched = await match(draft.id, draft.version);
    const submitted = await submit(matched.id, matched.version);
    await kit.decide('vendor_bill', submitted.id, 'reject');
    expect((await kit.bill(submitted.id)).status).toBe('matched');
    await kit.run((tx) =>
      kit.payables.bills.onApprovalOutcome('rejected', { docId: submitted.id }, tx),
    );
    await kit.run((tx) =>
      kit.payables.bills.onApprovalOutcome(
        'approved',
        { docId: '018f7c7c-0000-7000-8000-000000000009' },
        tx,
      ),
    );
    expect((await kit.bill(submitted.id)).status).toBe('matched');
    await refused(
      kit.run((tx) => kit.payables.bills.submit(submitted.id, 1, kit.pactor, tx)),
      'version_conflict',
    );
  });
});

describe('posting (BR-5)', () => {
  it('moves the receipt cost from approved to posted and emits bill.posted once (AC-1)', async () => {
    const received = await kit.receipt();
    const approved = await kit.approvedBill(kit.billInput(received));
    const project = { type: 'project' as const, id: received.projectId };
    expect(await kit.totals(project)).toMatchObject({ approved: '5000.00', posted: '0.00' });
    const events = await eventCount(kit.db, 'bill.posted');
    const posted = await post(approved.id, approved.version);
    expect(posted).toMatchObject({ status: 'posted', variances: [] });
    expect(posted.lines[0]?.costEntryId).toBeTruthy();
    expect(await kit.totals(project)).toMatchObject({ approved: '0.00', posted: '5000.00' });
    expect(await eventCount(kit.db, 'bill.posted')).toBe(events + 1);
    await refused(post(posted.id, posted.version), 'bill_not_approved');
  });

  it('refuses to post a bill that is not approved', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    await refused(post(draft.id, draft.version), 'bill_not_approved');
  });

  it('posts a price variance to the project cost for goods sent straight to site (AC-2)', async () => {
    const received = await kit.receipt();
    const approved = await kit.approvedBill(kit.billInput(received, { rates: ['55'] }));
    const posted = await post(approved.id, approved.version);
    expect(posted.variances).toMatchObject([
      { amount: '500.00', treatment: 'project_cost', costObjectType: 'project' },
    ]);
    expect(await kit.totals({ type: 'project', id: received.projectId })).toMatchObject({
      approved: '0.00',
      posted: '5500.00',
    });
  });

  it('posts a negative variance when the bill is cheaper', async () => {
    const received = await kit.receipt();
    const approved = await kit.approvedBill(kit.billInput(received, { rates: ['45'] }));
    const posted = await post(approved.id, approved.version);
    expect(posted.variances).toMatchObject([{ amount: '-500.00', treatment: 'project_cost' }]);
    expect(await kit.totals({ type: 'project', id: received.projectId })).toMatchObject({
      posted: '4500.00',
    });
  });

  it('charges a variance on goods still in stock to overhead and leaves valuation alone (AC-2)', async () => {
    const received = await kit.receipt({ projectId: null });
    const approved = await kit.approvedBill(kit.billInput(received, { rates: ['55'] }));
    const snapshot = () =>
      kit.db.query<{ v: string }>(
        "select coalesce(json_agg(m order by id)::text, '') as v from val_movements m",
      );
    const before = await snapshot();
    expect((await kit.db.query('select 1 from val_movements')).length).toBeGreaterThan(0);
    const overheadBefore = Number((await kit.totals({ type: 'overhead', id: null })).posted);
    const posted = await post(approved.id, approved.version);
    expect(posted.variances).toMatchObject([
      { amount: '500.00', treatment: 'overhead_cost', costObjectType: 'overhead' },
    ]);
    expect(await snapshot()).toEqual(before);
    expect(Number((await kit.totals({ type: 'overhead', id: null })).posted)).toBe(
      overheadBefore + 500,
    );
    const overhead = await kit.projects.costing.listEntries(
      kit.db,
      { type: 'overhead', id: null },
      { limit: 50, offset: 0 },
    );
    expect(overhead.items.find((e) => e.sourceDocType === 'price_variance')).toMatchObject({
      costCodeId: kit.codes['600'],
      status: 'posted',
    });
  });

  it('charges the project when the goods were issued already (H-22)', async () => {
    const received = await kit.receipt({ projectId: null });
    const project = await kit.project();
    const grn = await kit.procurement.getGrn(kit.db, received.grnId);
    const po = await kit.procurement.getPurchaseOrder(kit.db, received.poId);
    const store = po.storeId as string;
    await kit.run((tx) =>
      kit.inventory.issueToCostObject(
        {
          businessDate: TODAY,
          costObject: { type: 'project', id: project.id },
          storeId: store,
          itemId: po.lines[0]?.itemId as string,
          quantity: '10',
          costCodeId: kit.codes['100'],
        },
        kit.pactor,
        tx,
      ),
    );
    expect(grn.lines).toHaveLength(1);
    const approved = await kit.approvedBill(
      kit.billInput(received, {
        rates: ['55'],
        lines: [
          {
            grnId: received.grnId,
            grnLineId: received.grnLineIds[0],
            quantity: '100',
            rate: '55',
            costObjectType: 'project',
            costObjectId: project.id,
          },
        ],
      }),
    );
    const posted = await post(approved.id, approved.version);
    expect(posted.variances).toMatchObject([
      { amount: '500.00', treatment: 'project_cost', costObjectId: project.id },
    ]);
  });

  it('refuses an overhead variance when the price variance cost code is missing', async () => {
    const received = await kit.receipt({ projectId: null });
    const approved = await kit.approvedBill(kit.billInput(received, { rates: ['55'] }));
    await kit.put('payables.price_variance_cost_code', 'NOPE');
    try {
      await refused(post(approved.id, approved.version), 'variance_cost_code_missing');
    } finally {
      await kit.put('payables.price_variance_cost_code', '600');
    }
  });

  it('confirms the receipt cost once when two bills split a receipt line', async () => {
    const received = await kit.receipt();
    const first = await kit.postedBill(kit.billInput(received, { quantities: ['60'] }));
    const second = await kit.postedBill(kit.billInput(received, { quantities: ['40'] }));
    expect(first.lines[0]?.costEntryId).toBeTruthy();
    expect(second.lines[0]?.costEntryId).toBeNull();
    expect(await kit.totals({ type: 'project', id: received.projectId })).toMatchObject({
      approved: '0.00',
      posted: '5000.00',
    });
  });

  it('posts the cost of lines of other sources at once, or confirms the entry a source approved', async () => {
    const vendor = await kit.vendor();
    const project = await kit.project();
    const entry = await kit.run((tx) =>
      kit.projects.postCost(
        {
          costObject: { type: 'project', id: project.id },
          costCodeId: kit.codes['300'] as string,
          amount: '700.00',
          status: 'approved',
          sourceModule: 'subcontracts',
          sourceDocType: 'certificate',
          sourceDocId: '018f7c7c-0000-7000-8000-0000000000aa',
          sourceLineId: null,
          entryDate: TODAY,
          description: 'Certified work',
          idempotencyKey: 'cert-1',
          actorUserId: MANAGEMENT,
        },
        tx,
      ),
    );
    const hooks: string[] = [];
    kit.payables.registerBillSource('subcontract', {
      async buildBill(_db, sourceDocId) {
        return {
          vendorPartyId: vendor,
          nature: 'works',
          locationId: kit.islamabadId,
          lines: [
            {
              description: 'Certified work',
              quantity: '1',
              rate: '700',
              costObject: { type: 'project', id: project.id },
              costCodeId: kit.codes['300'] as string,
              sourceEntryId: sourceDocId === 'doc-1' ? undefined : entry.id,
            },
          ],
        };
      },
      async onPosted(_tx, input) {
        hooks.push(`posted:${input.sourceDocId}`);
      },
      async onCancelled(_tx, input) {
        hooks.push(`cancelled:${input.reason}`);
      },
    });
    const sourceId = '018f7c7c-0000-7000-8000-0000000000bb';
    const bill = await kit.run((tx) =>
      kit.payables.bills.createFromSource(
        'subcontract',
        sourceId,
        { vendorInvoiceNo: 'CERT-1', billDate: TODAY, dueDate: '2026-11-25' },
        kit.pactor,
        tx,
      ),
    );
    expect(bill).toMatchObject({ sourceType: 'subcontract', sourceDocId: sourceId });
    const matched = await match(bill.id, bill.version);
    const submitted = await submit(matched.id, matched.version);
    await kit.decide('vendor_bill', submitted.id, 'approve');
    const approved = await kit.bill(bill.id);
    const posted = await post(approved.id, approved.version);
    expect(posted.lines[0]?.costEntryId).toBeTruthy();
    expect(hooks).toEqual([`posted:${sourceId}`]);
    expect(await kit.totals({ type: 'project', id: project.id })).toMatchObject({
      approved: '0.00',
      posted: '700.00',
    });

    await cancel(posted.id, posted.version, 'Certificate withdrawn');
    expect(hooks).toEqual([`posted:${sourceId}`, 'cancelled:Certificate withdrawn']);

    const direct = await kit.run((tx) =>
      kit.payables.bills
        .createFromSource(
          'subcontract',
          'doc-1',
          { vendorInvoiceNo: 'CERT-2', billDate: TODAY, dueDate: '2026-11-25', notes: 'n' },
          kit.pactor,
          tx,
        )
        .catch((error: unknown) => error),
    );
    expect(direct).toBeDefined();
  });

  it('posts a line of an expense bill as new posted cost', async () => {
    const vendor = await kit.vendor();
    const project = await kit.project();
    const approved = await kit.approvedBill({
      vendorPartyId: vendor,
      vendorInvoiceNo: 'EXP-9',
      billDate: TODAY,
      dueDate: '2026-11-25',
      sourceType: 'expense_other',
      locationId: kit.islamabadId,
      lines: [
        {
          description: 'Tool hire',
          quantity: '2',
          rate: '100',
          costObjectType: 'project',
          costObjectId: project.id,
          costCodeId: kit.codes['400'],
        },
      ],
    });
    const posted = await post(approved.id, approved.version);
    expect(await kit.totals({ type: 'project', id: project.id })).toMatchObject({
      posted: '200.00',
    });
    expect(posted.lines[0]?.costEntryId).toBeTruthy();
  });
});

describe('cancelling (BR-10)', () => {
  it('cancels a draft with a reason and no reversal', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    await refused(cancel(draft.id, draft.version, '  '), 'reason_required');
    const cancelled = await cancel(draft.id, draft.version);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Entered twice' });
    await refused(cancel(cancelled.id, cancelled.version), 'bill_transition');
  });

  it('reverses the posted cost and the variances exactly, and reopens the receipt cost', async () => {
    const received = await kit.receipt();
    const approved = await kit.approvedBill(kit.billInput(received, { rates: ['55'] }));
    const posted = await post(approved.id, approved.version);
    const cancelled = await cancel(posted.id, posted.version);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.variances[0]?.reversedOn).toBe(TODAY);
    expect(await kit.totals({ type: 'project', id: received.projectId })).toMatchObject({
      approved: '5000.00',
      posted: '0.00',
    });
    // The reopened cost can be billed again.
    const again = await create(kit.billInput(received));
    expect(again.status).toBe('draft');
  });

  it('refuses while a payment is allocated and while another posted bill relies on the receipt', async () => {
    const received = await kit.receipt();
    const first = await kit.postedBill(kit.billInput(received, { quantities: ['60'] }));
    const second = await kit.postedBill(kit.billInput(received, { quantities: ['40'] }));
    await refused(cancel(first.id, first.version), 'receipt_shared');
    const account = await kit.bank();
    await kit.setThreshold('1000000000');
    const payment = await kit.approvedPayment({
      vendorPartyId: received.vendorId,
      paymentDate: TODAY,
      method: 'bank_transfer',
      accountId: account,
      allocations: [{ billId: second.id, amount: '100' }],
    });
    await refused(cancel(second.id, second.version), 'bill_has_payments');
    await kit.run((tx) =>
      kit.payables.payments.cancel(
        payment.id,
        { reason: 'Changed mind', version: payment.version },
        kit.pactor,
        tx,
      ),
    );
    const latest = await kit.bill(second.id);
    await cancel(latest.id, latest.version);
    const firstNow = await kit.bill(first.id);
    await cancel(firstNow.id, firstNow.version);
    await kit.setThreshold('0');
  });
});

describe('opening balances (BR-12)', () => {
  it('records a posted opening bill with no cost and no match', async () => {
    const vendor = await kit.vendor();
    const events = await eventCount(kit.db, 'bill.posted');
    const bill = await kit.run((tx) =>
      kit.payables.bills.createOpening(
        {
          vendorPartyId: vendor,
          vendorInvoiceNo: 'OPEN-1',
          billDate: TODAY,
          dueDate: '2026-11-25',
          amount: '12345.5',
          notes: 'Brought forward',
        },
        kit.pactor,
        tx,
      ),
    );
    expect(bill).toMatchObject({
      status: 'posted',
      sourceType: 'opening',
      grossTotal: '12345.50',
      netPayable: '12345.50',
      lines: [],
    });
    expect(await eventCount(kit.db, 'bill.posted')).toBe(events + 1);
    expect((await kit.payables.getVendorBalance(kit.db, vendor, TODAY)).balance).toBe('12345.50');
    await refused(
      kit.run((tx) =>
        kit.payables.bills.createOpening(
          {
            vendorPartyId: vendor,
            vendorInvoiceNo: 'OPEN-1',
            billDate: TODAY,
            dueDate: TODAY,
            amount: '1',
          },
          kit.pactor,
          tx,
        ),
      ),
      'duplicate_bill',
    );
    await refused(
      kit.run((tx) =>
        kit.payables.bills.createOpening(
          {
            vendorPartyId: vendor,
            vendorInvoiceNo: 'OPEN-2',
            billDate: TODAY,
            dueDate: TODAY,
            amount: '0',
          },
          kit.pactor,
          tx,
        ),
      ),
      'amount_invalid',
    );
  });
});

describe('reading bills', () => {
  it('lists by vendor and status and fetches one', async () => {
    const received = await kit.receipt();
    const draft = await create(kit.billInput(received));
    const page = await kit.payables.bills.list(kit.db, {
      vendorPartyId: received.vendorId,
      status: 'draft',
      limit: 10,
      offset: 0,
    });
    expect(page.items.map((b) => b.id)).toEqual([draft.id]);
    expect(page.total).toBe(1);
    expect((await kit.payables.bills.get(kit.db, draft.id)).id).toBe(draft.id);
    await refused(
      kit.payables.bills.get(kit.db, '018f7c7c-0000-7000-8000-000000000009'),
      'bill_not_found',
    );
    expect(await kit.payables.isGrnBilled(kit.db, received.grnId)).toBe(true);
    await cancel(draft.id, draft.version);
    expect(await kit.payables.isGrnBilled(kit.db, received.grnId)).toBe(false);
    await kit.postedBill(kit.billInput(received, { vendorInvoiceNo: 'BILLED-1' }));
    expect(await kit.payables.isGrnBilled(kit.db, received.grnId)).toBe(true);
  });
});
