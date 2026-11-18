import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBillingKit, uid, type BillingKit } from '../test-support.js';
import {
  countInvoices,
  decideEdit,
  deletePlannedStages,
  findAdvance,
  findAdvanceByInvoice,
  findCreditNote,
  findEdit,
  findInvoice,
  findStages,
  insertAdvance,
  insertCreditNote,
  insertEdit,
  insertInvoice,
  insertStage,
  issuedCreditBase,
  listAdvances,
  listCreditNotes,
  listLines,
  listStages,
  lockedAdvances,
  netBilled,
  pendingEditId,
  priorCredits,
  replaceLines,
  searchInvoices,
  setStagesStatus,
  stagesOnLiveInvoices,
  taxReportRows,
  unappliedAdvance,
  updateAdvance,
  updateCreditNote,
  updateInvoice,
} from './billing.repo.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

const AT = new Date('2026-11-18T10:00:00Z');
const BY = uid(3);
let n = 50_000;
const next = () => uid(++n);

async function stage(projectId: string, stageNo: number, amount = '100.00') {
  return insertStage(
    kit.db,
    {
      id: next(),
      project_id: projectId,
      stage_no: stageNo,
      name: `S${stageNo}`,
      amount,
      source: 'manual',
    },
    BY,
    AT,
  );
}

async function invoice(projectId: string, over: Record<string, unknown> = {}) {
  return insertInvoice(
    kit.db,
    {
      id: next(),
      source_type: 'project_stage',
      project_id: projectId,
      party_id: next(),
      invoice_date: '2026-11-18',
      due_date: '2026-12-18',
      base_amount: '100.00',
      ...over,
    },
    BY,
    AT,
  );
}

describe('schedule queries', () => {
  it('inserts, lists, finds and re-statuses stages, and replaces the planned ones', async () => {
    const project = next();
    const a = await stage(project, 1);
    const b = await stage(project, 2, '50.50');
    expect(
      (await listStages(kit.db, project)).map((s) => [s.stage_no, s.amount, s.status]),
    ).toEqual([
      [1, '100.00', 'planned'],
      [2, '50.50', 'planned'],
    ]);
    expect((await findStages(kit.db, project, [b.id, a.id])).map((s) => s.stage_no)).toEqual([
      1, 2,
    ]);
    expect(await findStages(kit.db, next(), [a.id])).toEqual([]);
    await setStagesStatus(kit.db, [a.id], 'invoiced', BY, AT);
    await deletePlannedStages(kit.db, project);
    expect((await listStages(kit.db, project)).map((s) => s.stage_no)).toEqual([1]);
    await setStagesStatus(kit.db, [a.id], 'cancelled', BY, AT);
    expect(await listStages(kit.db, project)).toEqual([]);
  });

  it('finds the stages that are on a live invoice, ignoring one invoice and cancelled invoices', async () => {
    const project = next();
    const s = await stage(project, 1);
    const live = await invoice(project);
    await replaceLines(kit.db, live.id, [
      {
        id: next(),
        lineNo: 1,
        scheduleId: s.id,
        description: 'x',
        amount: '100',
        supplyKind: 'services',
        nature: null,
      },
    ]);
    expect(await stagesOnLiveInvoices(kit.db, [s.id], null)).toEqual([s.id]);
    expect(await stagesOnLiveInvoices(kit.db, [s.id], live.id)).toEqual([]);
    await updateInvoice(kit.db, live.id, live.version, { status: 'cancelled' }, BY, AT);
    expect(await stagesOnLiveInvoices(kit.db, [s.id], null)).toEqual([]);
  });

  it('keeps schedule edits: insert, find, list pending, decide', async () => {
    const project = next();
    const id = next();
    expect(await pendingEditId(kit.db, project)).toBeNull();
    await insertEdit(kit.db, {
      id,
      projectId: project,
      previous: [
        {
          id: next(),
          stageNo: 1,
          name: 'A',
          basisPercent: '10.0000',
          amount: '5.00',
          source: 'quotation',
          sourceId: null,
        },
      ],
      by: BY,
      at: AT,
    });
    expect(await pendingEditId(kit.db, project)).toBe(id);
    expect(await findEdit(kit.db, id)).toMatchObject({
      project_id: project,
      status: 'pending_approval',
    });
    expect((await findEdit(kit.db, id))?.previous[0]).toMatchObject({ name: 'A', amount: '5.00' });
    await decideEdit(kit.db, id, 'approved', AT);
    expect(await pendingEditId(kit.db, project)).toBeNull();
    expect(await findEdit(kit.db, next())).toBeUndefined();
  });
});

describe('invoice queries', () => {
  it('inserts, finds, updates with a version and searches invoices', async () => {
    const project = next();
    const row = await invoice(project, { notes: 'n' });
    expect(row).toMatchObject({
      status: 'draft',
      base_amount: '100.00',
      invoice_date: '2026-11-18',
      version: 1,
      number: null,
    });
    expect((await findInvoice(kit.db, row.id, true))?.id).toBe(row.id);
    const updated = await updateInvoice(
      kit.db,
      row.id,
      1,
      { notes: 'changed', tax_snapshot: JSON.stringify({ a: 1 }) },
      BY,
      AT,
    );
    expect(updated).toMatchObject({ notes: 'changed', version: 2, tax_snapshot: { a: 1 } });
    expect(await updateInvoice(kit.db, row.id, 1, { notes: 'stale' }, BY, AT)).toBeUndefined();
    await invoice(project, { status: 'pending_approval' });
    expect((await searchInvoices(kit.db, { projectId: project, limit: 10, offset: 0 })).total).toBe(
      2,
    );
    const filtered = await searchInvoices(kit.db, {
      projectId: project,
      status: 'draft',
      limit: 10,
      offset: 0,
    });
    expect(filtered.rows.map((r) => r.id)).toEqual([row.id]);
    expect(
      (await searchInvoices(kit.db, { projectId: project, limit: 1, offset: 1 })).rows,
    ).toHaveLength(1);
    expect((await searchInvoices(kit.db, { limit: 1, offset: 0 })).total).toBeGreaterThan(2);
    expect(await countInvoices(kit.db, project)).toBe(2);
    expect(await findInvoice(kit.db, next())).toBeUndefined();
  });

  it('replaces the lines as a whole', async () => {
    const row = await invoice(next());
    const line = (lineNo: number, description: string) => ({
      id: next(),
      lineNo,
      scheduleId: null,
      description,
      amount: '10.5',
      supplyKind: 'services',
      nature: 'civil',
    });
    await replaceLines(kit.db, row.id, [line(1, 'a'), line(2, 'b')]);
    await replaceLines(kit.db, row.id, [line(1, 'c')]);
    expect(await listLines(kit.db, row.id)).toEqual([
      {
        line_no: 1,
        schedule_id: null,
        description: 'c',
        amount: '10.50',
        supply_kind: 'services',
        nature: 'civil',
      },
    ]);
  });

  it('nets the billed amount: base less recovery, less issued credit, for the chosen statuses', async () => {
    const project = next();
    const issued = await invoice(project, {
      status: 'issued',
      number: 'T-1',
      tax_snapshot: '{"taxLines":[]}',
      base_amount: '1000.00',
      advance_recovery: '100.00',
    });
    await invoice(project, { base_amount: '500.00' });
    const credit = await insertCreditNote(
      kit.db,
      {
        id: next(),
        invoice_id: issued.id,
        reason: 'r',
        base_amount: '200.00',
        advance_restored: '20.00',
        status: 'issued',
        number: 'C-1',
        issued_on: '2026-11-18',
      },
      BY,
      AT,
    );
    expect(credit.status).toBe('issued');
    expect(await netBilled(kit.db, project, ['issued'], null)).toBe('720.00');
    expect(await netBilled(kit.db, project, ['issued', 'draft'], null)).toBe('1220.00');
    expect(await netBilled(kit.db, project, ['issued', 'draft'], issued.id)).toBe('500.00');
    expect(await netBilled(kit.db, next(), ['issued'], null)).toBe('0.00');
  });
});

describe('advance queries', () => {
  it('inserts, finds, updates, lists and totals advances', async () => {
    const project = next();
    const party = next();
    const first = await insertAdvance(
      kit.db,
      { id: next(), project_id: project, party_id: party, amount: '100.00' },
      BY,
      AT,
    );
    expect(first).toMatchObject({ status: 'requested', applied: '0.00', received_on: null });
    expect(await unappliedAdvance(kit.db, project)).toBe('0.00');
    const received = await updateAdvance(
      kit.db,
      first.id,
      1,
      { status: 'received', received_on: '2026-11-18' },
      BY,
      AT,
    );
    expect(received).toMatchObject({ status: 'received', received_on: '2026-11-18' });
    expect(await updateAdvance(kit.db, first.id, 1, { applied: '1' }, BY, AT)).toBeUndefined();
    await updateAdvance(kit.db, first.id, 2, { applied: '30.00' }, BY, AT);
    expect(await unappliedAdvance(kit.db, project)).toBe('70.00');
    const second = await insertAdvance(
      kit.db,
      { id: next(), project_id: project, party_id: party, amount: '10.00' },
      BY,
      AT,
    );
    await updateAdvance(
      kit.db,
      second.id,
      1,
      { status: 'received', received_on: '2026-11-19' },
      BY,
      AT,
    );
    expect((await lockedAdvances(kit.db, project, 'asc')).map((a) => a.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await lockedAdvances(kit.db, project, 'desc')).map((a) => a.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect((await listAdvances(kit.db, project)).map((a) => a.id)).toEqual([first.id, second.id]);
    expect((await findAdvance(kit.db, first.id, true))?.applied).toBe('30.00');
    expect(await findAdvance(kit.db, next())).toBeUndefined();
    expect(await findAdvanceByInvoice(kit.db, next())).toBeUndefined();
    const inv = await invoice(project, { source_type: 'advance' });
    const linked = await insertAdvance(
      kit.db,
      { id: next(), project_id: project, party_id: party, amount: '5.00', invoice_id: inv.id },
      BY,
      AT,
    );
    expect((await findAdvanceByInvoice(kit.db, inv.id))?.id).toBe(linked.id);
  });
});

describe('credit note queries', () => {
  it('inserts, finds, updates and lists credit notes, and totals the prior ones', async () => {
    const issuedInvoice = await invoice(next(), {
      status: 'issued',
      number: 'T-2',
      tax_snapshot: '{"taxLines":[]}',
    });
    const draft = await insertCreditNote(
      kit.db,
      {
        id: next(),
        invoice_id: issuedInvoice.id,
        reason: 'a',
        base_amount: '40.00',
        advance_restored: '4.00',
        tax_total: '2.00',
        gross_total: '38.00',
      },
      BY,
      AT,
    );
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      issued_on: null,
      base_amount: '40.00',
    });
    const issued = await updateCreditNote(
      kit.db,
      draft.id,
      1,
      { status: 'issued', number: 'C-9', issued_on: '2026-11-18' },
      BY,
      AT,
    );
    expect(issued).toMatchObject({ status: 'issued', number: 'C-9', version: 2 });
    expect(await updateCreditNote(kit.db, draft.id, 1, { reason: 'x' }, BY, AT)).toBeUndefined();
    const other = await insertCreditNote(
      kit.db,
      {
        id: next(),
        invoice_id: issuedInvoice.id,
        reason: 'b',
        base_amount: '10.00',
        advance_restored: '1.00',
        tax_total: '0.50',
      },
      BY,
      AT,
    );
    expect(
      await priorCredits(kit.db, issuedInvoice.id, { issuedOnly: false, exceptId: null }),
    ).toEqual({
      base: '50.00',
      restored: '5.00',
      tax: '2.50',
    });
    expect(
      await priorCredits(kit.db, issuedInvoice.id, { issuedOnly: true, exceptId: null }),
    ).toEqual({
      base: '40.00',
      restored: '4.00',
      tax: '2.00',
    });
    expect(
      await priorCredits(kit.db, issuedInvoice.id, { issuedOnly: false, exceptId: draft.id }),
    ).toEqual({
      base: '10.00',
      restored: '1.00',
      tax: '0.50',
    });
    expect(await issuedCreditBase(kit.db, issuedInvoice.id)).toBe('40.00');
    expect((await listCreditNotes(kit.db, issuedInvoice.id)).map((c) => c.id)).toEqual([
      draft.id,
      other.id,
    ]);
    expect((await findCreditNote(kit.db, draft.id, true))?.number).toBe('C-9');
    expect(await findCreditNote(kit.db, next())).toBeUndefined();
  });
});

describe('tax report rows (P2-01 BR-8)', () => {
  it('lists numbered invoices and issued credit notes of one authority in a date range', async () => {
    const lahore = await kit.project({ where: 'lahore' });
    const invoice = await kit.issued(lahore.id, [1]);
    const credit = await kit.tx((tx) =>
      kit.billing.creditNotes.create(
        invoice.id,
        { reason: 'x', baseAmount: '100000' },
        kit.actor,
        tx,
      ),
    );
    await kit.tx((tx) => kit.billing.creditNotes.submit(credit.id, credit.version, kit.actor, tx));
    await kit.decide('credit_note', credit.id, 'approve');
    await kit.tx((tx) => kit.billing.creditNotes.issue(credit.id, credit.version, kit.actor, tx));
    const query = { authorityCode: 'PRA', from: '2026-11-01', to: '2026-11-30' };
    const rows = await taxReportRows(kit.db, query);
    expect(rows).toEqual([
      {
        documentId: invoice.id,
        kind: 'invoice',
        date: '2026-11-18',
        base: '1500000.00',
        tax: '240000.00',
      },
      {
        documentId: credit.id,
        kind: 'credit_note',
        date: '2026-11-18',
        base: '100000.00',
        tax: '16000.00',
      },
    ]);
    expect(await taxReportRows(kit.db, { ...query, to: '2026-11-17' })).toEqual([]);
    expect(await taxReportRows(kit.db, { ...query, authorityCode: 'FBR' })).toEqual([]);
    // The report adds them up through the source billing registered: output tax is invoices less credits.
    const report = await kit.tax.taxReportData(kit.db, 'PRA', '2026-11');
    expect(report.outputTax).toEqual({ base: '1400000.00', tax: '224000.00', documents: 2 });
  });
});
