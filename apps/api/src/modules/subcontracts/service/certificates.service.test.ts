import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createSubcontractsKit,
  PM2,
  TODAY,
  type SubcontractsKit,
} from '../test-support.js';

let kit: SubcontractsKit;
beforeAll(async () => {
  kit = await createSubcontractsKit();
}, 180_000);
afterAll(() => kit.close());

const MISSING = '018f7c7c-0000-7000-8000-00000000dead';

const refused = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string },
  );
  expect(error?.code).toBe(code);
};

const certs = () => kit.subcontracts.certificates;

const submit = async (id: string) => {
  const current = await kit.cert(id);
  return kit.run((tx) => certs().submit(id, current.version, kit.pm, tx));
};

describe('drafting a certificate (BR-2, BR-3)', () => {
  it('creates a cumulative draft with a number and audit entry', async () => {
    const order = await kit.activeOrder();
    const before = await auditCount(kit.db, 'subcontracts.certificate.create');
    const draft = await kit.draftCertificate(order.id, { notes: ' first ' });
    expect(draft).toMatchObject({
      status: 'draft',
      basis: 'percent_complete',
      cumulativePercent: '30.0000',
      cumulativeAmount: '300000.00',
      netCertified: '300000.00',
      notes: 'first',
    });
    expect(draft.number).toMatch(/^SCC-\d{4}-\d{4}$/);
    expect(await auditCount(kit.db, 'subcontracts.certificate.create')).toBe(before + 1);
    // One certificate is open at a time (the draft above): certify or cancel it first.
    await refused(
      kit.certified(order.id, { basis: 'amount', cumulativeAmount: '600000' }),
      'open_certificate',
    );
    await kit.run((tx) => certs().cancel(draft.id, draft.version, kit.pm, tx));
    const second = await kit.certified(order.id, { basis: 'amount', cumulativeAmount: '600000' });
    expect(second).toMatchObject({
      cumulativePercent: '60.0000',
      thisCertificateAmount: '600000.00',
    });
    // The next certificate steps up from the latest certified one.
    const third = await kit.draftCertificate(order.id, { cumulativePercent: '70' });
    expect(third.thisCertificateAmount).toBe('100000.00');
  });

  it('refuses certificates on an order that is not active, over the contract, or without new work', async () => {
    const draftOrder = await kit.draftOrder();
    await refused(
      kit.run((tx) =>
        certs().create(
          draftOrder.id,
          { certificateDate: TODAY, basis: 'percent_complete', cumulativePercent: '10' },
          kit.pm,
          tx,
        ),
      ),
      'order_not_active',
    );
    await refused(
      kit.run((tx) =>
        certs().create(
          MISSING,
          { certificateDate: TODAY, basis: 'percent_complete', cumulativePercent: '10' },
          kit.pm,
          tx,
        ),
      ),
      'work_order_not_found',
    );
    const order = await kit.activeOrder();
    await refused(kit.draftCertificate(order.id, { cumulativePercent: '100.5' }), 'over_certified');
    await refused(kit.draftCertificate(order.id, { cumulativePercent: '0' }), 'certificate_empty');
    await kit.certified(order.id, { cumulativePercent: '30' });
    await refused(
      kit.draftCertificate(order.id, { cumulativePercent: '20' }),
      'certificate_not_cumulative',
    );
    await refused(kit.draftCertificate(order.id, { cumulativePercent: '30' }), 'certificate_empty');
  });

  it('lets a supervisor of the project draft but not see amounts, and keeps others out', async () => {
    const order = await kit.activeOrder();
    const supervisor = kit.supervisorOf([order.projectId]);
    const draft = await kit.run((tx) =>
      certs().create(
        order.id,
        { certificateDate: TODAY, basis: 'percent_complete', cumulativePercent: '10' },
        supervisor,
        tx,
      ),
    );
    expect(draft).toMatchObject({
      cumulativePercent: '10.0000',
      cumulativeAmount: null,
      thisCertificateAmount: null,
      netCertified: null,
      deductions: null,
    });
    const stranger = kit.supervisorOf([]);
    await refused(
      kit.run((tx) =>
        certs().create(
          order.id,
          { certificateDate: TODAY, basis: 'percent_complete', cumulativePercent: '20' },
          stranger,
          tx,
        ),
      ),
      'project_not_found',
    );
    await refused(certs().get(kit.db, draft.id, stranger), 'project_not_found');
    await refused(certs().list(kit.db, order.id, stranger), 'project_not_found');
    const listed = await certs().list(kit.db, order.id, supervisor);
    expect(listed.map((c) => c.id)).toEqual([draft.id]);
    expect(listed[0]?.thisCertificateAmount).toBeNull();
    await refused(certs().get(kit.db, MISSING, kit.owner), 'certificate_not_found');
    await refused(certs().list(kit.db, MISSING, kit.owner), 'work_order_not_found');
  });

  it('updates only a draft and keeps the deductions of its back-charges', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id);
    await kit.backCharge(order.id, { certificateId: draft.id, amount: '5000' });
    const current = await kit.cert(draft.id);
    expect(current.deductions).toBe('5000.00');
    const input = {
      certificateDate: TODAY,
      basis: 'amount' as const,
      cumulativeAmount: '400000',
      notes: ' ',
      version: current.version,
    };
    const updated = await kit.run((tx) => certs().update(draft.id, input, kit.pm, tx));
    expect(updated).toMatchObject({
      cumulativeAmount: '400000.00',
      deductions: '5000.00',
      netCertified: '395000.00',
      notes: null,
    });
    await refused(
      kit.run((tx) => certs().update(draft.id, input, kit.pm, tx)),
      'version_conflict',
    );
    await refused(
      kit.run((tx) => certs().update(MISSING, input, kit.pm, tx)),
      'certificate_not_found',
    );
    await submit(draft.id);
    const pending = await kit.cert(draft.id);
    await refused(
      kit.run((tx) => certs().update(draft.id, { ...input, version: pending.version }, kit.pm, tx)),
      'certificate_not_editable',
    );
  });
});

describe('approval and cost entries (BR-4, T-2)', () => {
  it('posts approved cost for the gross and a negative entry only for a cost-recovering back-charge', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '50' });
    await kit.backCharge(order.id, {
      certificateId: draft.id,
      amount: '20000',
      recoversCost: true,
      costCodeId: kit.codes['100'] as string,
    });
    await kit.backCharge(order.id, {
      certificateId: draft.id,
      amount: '5000',
      description: 'Late finish',
    });
    const before = await auditCount(kit.db, 'subcontracts.certificate.approved');
    await submit(draft.id);
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    const certified = await kit.cert(draft.id);
    expect(certified).toMatchObject({
      status: 'certified',
      thisCertificateAmount: '500000.00',
      deductions: '25000.00',
      netCertified: '475000.00',
      certifiedBy: PM2,
      certifiedOn: TODAY,
    });
    expect(await auditCount(kit.db, 'subcontracts.certificate.approved')).toBe(before + 1);
    const rows = (await kit.ledger(order.projectId)).map((r) => [
      r.sourceDocType,
      r.status,
      r.amount,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['subcontract_certificate', 'approved', '500000.00'],
        ['subcontract_back_charge', 'approved', '-20000.00'],
      ]),
    );
    expect(rows.filter((r) => r[0] === 'subcontract_back_charge')).toHaveLength(1);
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '500000.00',
      approved: '480000.00',
      posted: '0.00',
    });
    // Replaying the approval event changes nothing.
    await kit.run((tx) => certs().onApprovalOutcome('approved', { docId: draft.id }, tx));
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '500000.00',
      approved: '480000.00',
      posted: '0.00',
    });
    await kit.run((tx) => certs().onApprovalOutcome('approved', { docId: MISSING }, tx));
    await refused(submit(draft.id), 'certificate_transition');
  });

  it('sends a rejected or returned certificate back to draft with its back-charges, and it can be resubmitted', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id);
    await kit.backCharge(order.id, { certificateId: draft.id });
    for (const action of ['reject', 'return'] as const) {
      await submit(draft.id);
      await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager', action);
      const back = await kit.cert(draft.id);
      expect(back).toMatchObject({ status: 'draft', deductions: '20000.00' });
      expect(back.backCharges).toHaveLength(1);
    }
    await submit(draft.id);
    await kit.run((tx) => certs().onApprovalOutcome('cancelled', { docId: draft.id }, tx));
    expect((await kit.cert(draft.id)).status).toBe('pending_approval');
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '1000000.00',
      approved: '0.00',
      posted: '0.00',
    });
  });

  it('refuses a stale version and cancels a draft or pending certificate, freeing its back-charges', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id);
    const charge = await kit.backCharge(order.id, { certificateId: draft.id });
    await refused(
      kit.run((tx) => certs().submit(draft.id, draft.version + 5, kit.pm, tx)),
      'version_conflict',
    );
    await refused(
      kit.run((tx) => certs().cancel(draft.id, draft.version + 5, kit.pm, tx)),
      'version_conflict',
    );
    const pending = await submit(draft.id);
    const cancelled = await kit.run((tx) => certs().cancel(draft.id, pending.version, kit.pm, tx));
    expect(cancelled.status).toBe('cancelled');
    const charges = await certs().listBackCharges(kit.db, order.id, kit.owner);
    expect(charges.find((c) => c.id === charge.id)?.certificateId).toBeNull();
    await refused(
      kit.run((tx) => certs().cancel(draft.id, cancelled.version, kit.pm, tx)),
      'certificate_transition',
    );
    // The freed back-charge goes onto a new draft, which can be cancelled without an approval.
    const next = await kit.draftCertificate(order.id);
    const link = await kit.run((tx) =>
      certs().updateBackCharge(
        charge.id,
        {
          description: 'Rework',
          amount: '20000',
          certificateId: next.id,
          version: (charges.find((c) => c.id === charge.id) as { version: number }).version,
        },
        kit.pm,
        tx,
      ),
    );
    expect(link.certificateId).toBe(next.id);
    expect(
      (await kit.run((tx) => certs().cancel(next.id, next.version + 1, kit.pm, tx))).status,
    ).toBe('cancelled');
  });

  it('completes the order at 100% and leaves nothing committed', async () => {
    const order = await kit.activeOrder();
    await kit.certified(order.id, { cumulativePercent: '100' });
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '0.00',
      approved: '1000000.00',
      posted: '0.00',
    });
    expect((await kit.order(order.id)).status).toBe('completed');
  });
});

describe('back-charges (BR-3)', () => {
  it('adds, links, edits and removes back-charges and recalculates the deductions', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '10' });
    const free = await kit.backCharge(order.id, { amount: '1000' });
    expect((await kit.cert(draft.id)).deductions).toBe('0.00');
    const linked = await kit.run((tx) =>
      certs().updateBackCharge(
        free.id,
        { description: ' Rework ', amount: '2500', certificateId: draft.id, version: free.version },
        kit.pm,
        tx,
      ),
    );
    expect(linked).toMatchObject({
      amount: '2500.00',
      certificateId: draft.id,
      description: 'Rework',
    });
    expect((await kit.cert(draft.id)).netCertified).toBe('97500.00');
    // Moving it to another place keeps the certificate in step.
    const same = await kit.run((tx) =>
      certs().updateBackCharge(
        free.id,
        { description: 'Rework', amount: '3000', certificateId: draft.id, version: linked.version },
        kit.pm,
        tx,
      ),
    );
    expect((await kit.cert(draft.id)).deductions).toBe('3000.00');
    const unlinked = await kit.run((tx) =>
      certs().updateBackCharge(
        free.id,
        { description: 'Rework', amount: '3000', certificateId: null, version: same.version },
        kit.pm,
        tx,
      ),
    );
    expect(unlinked.certificateId).toBeNull();
    expect((await kit.cert(draft.id)).deductions).toBe('0.00');
    await refused(
      kit.run((tx) =>
        certs().updateBackCharge(
          free.id,
          { description: 'x', amount: '3000', version: same.version },
          kit.pm,
          tx,
        ),
      ),
      'version_conflict',
    );
    const again = await kit.run((tx) =>
      certs().updateBackCharge(
        free.id,
        {
          description: 'Rework',
          amount: '3000',
          certificateId: draft.id,
          version: unlinked.version,
        },
        kit.pm,
        tx,
      ),
    );
    await kit.run((tx) => certs().removeBackCharge(free.id, again.version, kit.pm, tx));
    expect((await kit.cert(draft.id)).deductions).toBe('0.00');
    await refused(
      kit.run((tx) => certs().removeBackCharge(MISSING, 1, kit.pm, tx)),
      'back_charge_not_found',
    );
    // A free back-charge can be removed without any certificate.
    const lone = await kit.backCharge(order.id);
    await kit.run((tx) => certs().removeBackCharge(lone.id, lone.version, kit.pm, tx));
    await refused(
      kit.run((tx) => certs().removeBackCharge(lone.id, lone.version, kit.pm, tx)),
      'back_charge_not_found',
    );
  });

  it('refuses a back-charge that makes the net negative, and bad inputs', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '1' });
    await refused(
      kit.backCharge(order.id, { certificateId: draft.id, amount: '10001' }),
      'negative_net',
    );
    await refused(kit.backCharge(order.id, { amount: '0' }), 'back_charge_invalid');
    await refused(kit.backCharge(order.id, { description: ' ' }), 'description_required');
    await refused(kit.backCharge(order.id, { recoversCost: true }), 'cost_code_required');
    await refused(kit.backCharge(order.id, { costCodeId: kit.inactiveCode }), 'cost_code_inactive');
    const other = await kit.activeOrder();
    const foreign = await kit.draftCertificate(other.id);
    await refused(kit.backCharge(order.id, { certificateId: foreign.id }), 'certificate_not_found');
    await refused(kit.backCharge(order.id, { certificateId: MISSING }), 'certificate_not_found');
    await refused(
      kit.run((tx) =>
        certs().addBackCharge(MISSING, { description: 'x', amount: '1' }, kit.pm, tx),
      ),
      'work_order_not_found',
    );
    const draftOrder = await kit.draftOrder();
    await refused(kit.backCharge(draftOrder.id), 'order_not_active');
  });

  it('freezes the back-charges of a certified certificate and hides amounts from a supervisor', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id);
    const charge = await kit.backCharge(order.id, { certificateId: draft.id });
    await submit(draft.id);
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    const frozen = (await certs().listBackCharges(kit.db, order.id, kit.owner))[0] as {
      version: number;
    };
    await refused(
      kit.run((tx) =>
        certs().updateBackCharge(
          charge.id,
          { description: 'x', amount: '1', certificateId: null, version: frozen.version },
          kit.pm,
          tx,
        ),
      ),
      'certificate_not_editable',
    );
    await refused(
      kit.run((tx) => certs().removeBackCharge(charge.id, frozen.version, kit.pm, tx)),
      'certificate_not_editable',
    );
    const another = await kit.draftCertificate(order.id, { cumulativePercent: '40' });
    await refused(
      kit.backCharge(order.id, { certificateId: draft.id }),
      'certificate_not_editable',
    );
    const supervisor = kit.supervisorOf([order.projectId]);
    expect((await certs().listBackCharges(kit.db, order.id, supervisor))[0]?.amount).toBeNull();
    await refused(
      certs().listBackCharges(kit.db, order.id, kit.supervisorOf([])),
      'project_not_found',
    );
    await refused(certs().listBackCharges(kit.db, MISSING, kit.owner), 'work_order_not_found');
    await refused(
      kit.run((tx) =>
        certs().updateBackCharge(
          MISSING,
          { description: 'x', amount: '1', version: 1 },
          kit.pm,
          tx,
        ),
      ),
      'back_charge_not_found',
    );
    expect(another.status).toBe('draft');
  });
});

describe('billing a certificate through payables (BR-5, T-5)', () => {
  it('builds a bill of the net certified, posts the cost and marks the certificate billed', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '50' });
    await kit.backCharge(order.id, {
      certificateId: draft.id,
      amount: '20000',
      recoversCost: true,
      costCodeId: kit.codes['100'] as string,
    });
    await submit(draft.id);
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    await refused(
      kit.run((tx) =>
        certs().bill(
          MISSING,
          { vendorInvoiceNo: 'X', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      ),
      'certificate_not_found',
    );
    const bill = await kit.postedBillOf(draft.id);
    expect(bill).toMatchObject({
      sourceType: 'subcontract',
      baseAmount: '480000.00',
      vendorPartyId: order.partyId,
    });
    expect(bill.lines).toHaveLength(1);
    const billed = await kit.cert(draft.id);
    expect(billed).toMatchObject({ status: 'billed', billId: bill.id });
    // The gross cost and the recovery are both posted; nothing is left approved.
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '500000.00',
      approved: '0.00',
      posted: '480000.00',
    });
    await kit.run((tx) =>
      certs().provider.onPosted(tx, { billId: bill.id, sourceDocId: draft.id }),
    );
    await kit.run((tx) => certs().provider.onPosted(tx, { billId: bill.id, sourceDocId: MISSING }));
    expect((await kit.cert(draft.id)).status).toBe('billed');
    await refused(
      kit.run((tx) =>
        certs().bill(
          draft.id,
          { vendorInvoiceNo: 'again', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      ),
      'certificate_not_certified',
    );
  });

  it('gives the cost back as approved when the posted bill is cancelled, and can bill again', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '50' });
    await kit.backCharge(order.id, {
      certificateId: draft.id,
      amount: '20000',
      recoversCost: true,
      costCodeId: kit.codes['100'] as string,
    });
    await kit.backCharge(order.id, { certificateId: draft.id, amount: '1000' });
    await submit(draft.id);
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    const bill = await kit.postedBillOf(draft.id);
    const cancelled = await kit.run((tx) =>
      kit.payables.bills.cancel(
        bill.id,
        { reason: 'Wrong invoice', version: bill.version },
        kit.pactor,
        tx,
      ),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await kit.cert(draft.id)).toMatchObject({ status: 'certified', billId: null });
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '500000.00',
      approved: '480000.00',
      posted: '0.00',
    });
    await kit.run((tx) =>
      certs().provider.onCancelled(tx, { billId: bill.id, sourceDocId: draft.id, reason: 'again' }),
    );
    await kit.run((tx) =>
      certs().provider.onCancelled(tx, { billId: bill.id, sourceDocId: MISSING, reason: 'again' }),
    );
    // A second bill for the same certificate works and posts the cost again.
    const second = await kit.postedBillOf(draft.id);
    expect(second.id).not.toBe(bill.id);
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '500000.00',
      approved: '0.00',
      posted: '480000.00',
    });
  });

  it('allows a new bill after one that was cancelled before posting, and refuses a second live bill', async () => {
    const order = await kit.activeOrder();
    const certified = await kit.certified(order.id, { cumulativePercent: '20' });
    const input = (n: number) => ({
      vendorInvoiceNo: `LIVE-${n}`,
      billDate: TODAY,
      dueDate: '2026-11-25',
      notes: ' n ',
    });
    const first = await kit.run((tx) => certs().bill(certified.id, input(1), kit.acct, tx));
    expect(first.certificate.billId).toBe(first.bill.id);
    await refused(
      kit.run((tx) => certs().bill(certified.id, input(2), kit.acct, tx)),
      'already_billed',
    );
    await kit.run((tx) =>
      kit.payables.bills.cancel(
        first.bill.id,
        { reason: 'Typo', version: first.bill.version },
        kit.pactor,
        tx,
      ),
    );
    const second = await kit.run((tx) => certs().bill(certified.id, input(3), kit.acct, tx));
    expect(second.bill.id).not.toBe(first.bill.id);
  });

  it('needs a vendor invoice number', async () => {
    const order = await kit.activeOrder();
    const certified = await kit.certified(order.id, { cumulativePercent: '20' });
    await refused(
      kit.run((tx) =>
        certs().bill(
          certified.id,
          { vendorInvoiceNo: ' ', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      ),
      'vendor_invoice_no_required',
    );
  });

  it('refuses to bill a certificate that is not certified or whose net is zero', async () => {
    const order = await kit.activeOrder();
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '10' });
    await refused(
      kit.run((tx) =>
        certs().bill(
          draft.id,
          { vendorInvoiceNo: 'D-1', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      ),
      'certificate_not_certified',
    );
    await kit.backCharge(order.id, { certificateId: draft.id, amount: '100000' });
    expect((await kit.cert(draft.id)).netCertified).toBe('0.00');
    await submit(draft.id);
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    await refused(
      kit.run((tx) =>
        certs().bill(
          draft.id,
          { vendorInvoiceNo: 'D-2', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      ),
      'net_not_billable',
    );
    await refused(certs().provider.buildBill(kit.db, draft.id), 'net_not_billable');
  });

  it('bills a labour contractor and builds a bill for a project without a location', async () => {
    const project = await kit.project();
    const partyId = await kit.contractor(['labour_contractor']);
    const draft = await kit.run((tx) =>
      kit.subcontracts.orders.create(kit.orderInput(project.id, partyId), kit.pm, tx),
    );
    await kit.run((tx) => kit.subcontracts.orders.submit(draft.id, draft.version, kit.pm, tx));
    await kit.decide('subcontract_order', draft.id, 'approve');
    const certified = await kit.certified(draft.id, { cumulativePercent: '10' });
    const built = await certs().provider.buildBill(kit.db, certified.id);
    expect(built).toMatchObject({
      vendorPartyId: partyId,
      supplyKind: 'services',
      nature: 'subcontract',
    });
    expect(built.locationId).toBeUndefined();
    expect(built.lines[0]).toMatchObject({
      quantity: '1',
      rate: '100000.00',
      costCodeId: kit.codes['300'],
    });
    await refused(certs().provider.buildBill(kit.db, MISSING), 'certificate_not_found');
    // Payables accepts the labour contractor as a vendor; without a location it has no tax authority.
    const error = await kit
      .run((tx) =>
        certs().bill(
          certified.id,
          { vendorInvoiceNo: 'LAB-1', billDate: TODAY, dueDate: TODAY },
          kit.acct,
          tx,
        ),
      )
      .catch((e: unknown) => e as { code?: string });
    expect((error as { code?: string }).code).not.toBe('not_a_vendor');
  });
});
