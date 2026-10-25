import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  MANAGEMENT,
  PM,
  auditCount,
  createQuotationsKit,
  eventCount,
  type QuotationsKit,
} from '../test-support.js';

let kit: QuotationsKit;
beforeAll(async () => {
  kit = await createQuotationsKit();
}, 60_000);
afterAll(() => kit.close());

const service = () => kit.quotations.service;
const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);
const get = (id: string, margin = true) => service().get(kit.db, id, margin);
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};
const MISSING = '018f0000-0000-7000-8000-000000000999';

const stages = [
  { name: 'Advance', basis: 'percent' as const, percent: '30', conditionText: 'On signing' },
  { name: 'Completion', basis: 'percent' as const, percent: '70' },
];

const setNow = (iso: string) => {
  kit.now.current = new Date(iso);
};
const START = '2026-10-25T10:00:00Z';

describe('create (BR-1, BR-3, BR-7)', () => {
  it('builds a draft from a locked estimate with its defaults', async () => {
    const estimate = await kit.lockedEstimate({ price: '1200.00' });
    const id = await kit.draft({}, estimate);
    const quotation = await get(id);
    expect(quotation).toMatchObject({
      revision: 1,
      displayNumber: quotation.number,
      status: 'draft',
      estimateId: estimate.id,
      partyId: kit.clientId,
      sector: 'private',
      title: 'Synthetic wall',
      validityDays: 30,
      price: '1200.00',
      scopeText: 'Build a boundary wall',
      inclusions: 'Materials and labour',
      exclusions: 'Painting',
      terms: 'Payment within 7 days',
      parentId: null,
      locationId: null,
      leadId: null,
    });
    expect(quotation.number).toMatch(/^QUO-2026-\d{4}$/);
    expect(quotation.stages.map((s) => [s.stageNo, s.name, s.percent, s.amount])).toEqual([
      [1, 'Advance', '30.0000', '360.00'],
      [2, 'Completion', '70.0000', '840.00'],
    ]);
    expect(quotation.history).toMatchObject([{ fromStatus: null, toStatus: 'draft' }]);
    expect(quotation.approval).toEqual({ status: 'none', requestId: null, currentRole: null });
    expect(await auditCount(kit.db, 'quotations.quotation.create')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'quotations.quotation.changed')).toBeGreaterThan(0);
  });

  it('creates with the stages alone: empty texts, estimate price, and keeps the price on update', async () => {
    const estimate = await kit.lockedEstimate({ price: '800' });
    const created = await tx((t) =>
      service().create(
        { estimateId: estimate.id, stages: [{ name: 'All', basis: 'percent', percent: '100' }] },
        kit.actor,
        t,
        false,
      ),
    );
    expect(created).toMatchObject({
      scopeText: '',
      inclusions: '',
      exclusions: '',
      terms: '',
      price: '800.00',
    });
    const updated = await tx((t) =>
      service().update(
        created.id,
        {
          stages: [
            { name: 'Half', basis: 'percent', percent: '50' },
            { name: 'Rest', basis: 'percent', percent: '50' },
          ],
        },
        created.version,
        kit.actor,
        t,
        false,
      ),
    );
    expect(updated.price).toBe('800.00');
    expect(updated.stages.map((s) => s.amount)).toEqual(['400.00', '400.00']);
  });

  it('takes an explicit price, title, party, location and validity, and amount stages', async () => {
    const id = await kit.draft({
      price: '1000.50',
      title: '  Custom title ',
      partyId: kit.clientId,
      locationId: kit.locationId,
      validityDays: 10,
      stages: [
        { name: 'First', basis: 'amount', amount: '500.25' },
        { name: 'Second', basis: 'amount', amount: '500.25' },
      ],
    });
    expect(await get(id)).toMatchObject({
      price: '1000.50',
      title: 'Custom title',
      locationId: kit.locationId,
      validityDays: 10,
    });
  });

  it('defaults the client and location from the lead when the estimate has no client', async () => {
    const leadId = await kit.newLead();
    const estimate = await kit.lockedEstimate({ partyId: null, leadId });
    const id = await kit.draft({ locationId: undefined }, estimate);
    const quotation = await get(id);
    expect(quotation.leadId).toBe(leadId);
    expect(quotation.partyId).toBe(kit.clientId);
  });

  it('accepts a lead given on the request, and an explicit null to clear it', async () => {
    const leadId = await kit.newLead();
    expect((await get(await kit.draft({ leadId }))).leadId).toBe(leadId);
    const estimate = await kit.lockedEstimate({ leadId });
    expect((await get(await kit.draft({ leadId: null }, estimate))).leadId).toBeNull();
  });

  it('refuses an estimate that is not locked (BR-1)', async () => {
    const draftEstimate = await tx((t) =>
      kit.estimation.estimates.create(
        {
          title: 'Unlocked',
          workType: 'room',
          sector: 'private',
          partyId: kit.clientId,
          proposedPrice: '100',
          lines: [],
        },
        { userId: ADMIN, requestId: null },
        t,
      ),
    );
    expect(
      await codeOf(
        tx((t) => service().create({ estimateId: draftEstimate.id, stages }, kit.actor, t, true)),
      ),
    ).toBe('estimate_not_locked');
  });

  it('refuses an unknown estimate, a missing price and a zero price', async () => {
    expect(
      await codeOf(
        tx((t) => service().create({ estimateId: MISSING, stages }, kit.actor, t, true)),
      ),
    ).toBe('estimate_not_found');
    const noPrice = await kit.lockedEstimate({ price: null });
    expect(await codeOf(kit.draft({}, noPrice))).toBe('price_invalid');
    expect(await codeOf(kit.draft({ price: '0' }))).toBe('price_not_positive');
  });

  it('refuses a missing or unknown client, location or lead, and a bad validity', async () => {
    const noParty = await kit.lockedEstimate({ partyId: null });
    expect(await codeOf(kit.draft({}, noParty))).toBe('party_required');
    expect(await codeOf(kit.draft({ partyId: MISSING }))).toBe('unknown_party');
    expect(await codeOf(kit.draft({ locationId: MISSING }))).toBe('unknown_location');
    expect(await codeOf(kit.draft({ leadId: MISSING }))).toBe('lead_not_found');
    expect(await codeOf(kit.draft({ validityDays: 0 }))).toBe('validity_days_invalid');
  });

  it('refuses stage schedules that do not add up (T-1)', async () => {
    expect(
      await codeOf(
        kit.draft({
          stages: [
            { name: 'A', basis: 'percent', percent: '50' },
            { name: 'B', basis: 'percent', percent: '40' },
          ],
        }),
      ),
    ).toBe('stage_percent_sum');
    expect(await codeOf(kit.draft({ stages: [] }))).toBe('stages_required');
    expect(
      await codeOf(
        kit.draft({
          stages: [
            { name: 'A', basis: 'amount', amount: '100' },
            { name: 'B', basis: 'amount', amount: '100' },
          ],
        }),
      ),
    ).toBe('stage_amount_sum');
  });

  it('numbers revisions with the same base number (BR-7)', async () => {
    const id = await kit.draft();
    await kit.issued(id);
    const first = await get(id);
    const revision = await tx((t) => service().revise(id, kit.actor, t, true));
    expect(revision.number).toBe(first.number);
    expect(revision.revision).toBe(2);
    expect(revision.displayNumber).toBe(`${first.number}/2`);
    expect(revision.parentId).toBe(id);
  });
});

describe('update and remove (BR-4)', () => {
  it('replaces fields and the schedule, keeping what is not given', async () => {
    const id = await kit.draft({ locationId: kit.locationId });
    const before = await get(id);
    const updated = await tx((t) =>
      service().update(
        id,
        { price: '2000', stages: [{ name: 'Whole', basis: 'percent', percent: '100' }] },
        before.version,
        kit.actor,
        t,
        true,
      ),
    );
    expect(updated).toMatchObject({
      price: '2000.00',
      scopeText: 'Build a boundary wall',
      inclusions: 'Materials and labour',
      exclusions: 'Painting',
      terms: 'Payment within 7 days',
      title: 'Synthetic wall',
      locationId: kit.locationId,
      partyId: kit.clientId,
      validityDays: 30,
      version: before.version + 1,
    });
    expect(updated.stages.map((s) => s.amount)).toEqual(['2000.00']);
  });

  it('changes the texts, the estimate and the client', async () => {
    const id = await kit.draft();
    const before = await get(id);
    const other = await kit.lockedEstimate({ cost: '500', price: '900' });
    const updated = await tx((t) =>
      service().update(
        id,
        {
          estimateId: other.id,
          title: 'New',
          partyId: kit.clientId,
          leadId: null,
          scopeText: ' s ',
          inclusions: ' i ',
          exclusions: ' e ',
          terms: ' t ',
          validityDays: 5,
          price: '900',
          stages,
        },
        before.version,
        kit.actor,
        t,
        false,
      ),
    );
    expect(updated).toMatchObject({
      estimateId: other.id,
      title: 'New',
      scopeText: 's',
      inclusions: 'i',
      exclusions: 'e',
      terms: 't',
      validityDays: 5,
      price: '900.00',
      margin: null,
    });
  });

  it('answers a stale version with a conflict and an unknown id with not found', async () => {
    const id = await kit.draft();
    const before = await get(id);
    expect(
      await codeOf(
        tx((t) => service().update(id, { stages }, before.version + 5, kit.actor, t, true)),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(tx((t) => service().update(MISSING, { stages }, 1, kit.actor, t, true))),
    ).toBe('quotation_not_found');
    expect(await codeOf(get(MISSING))).toBe('quotation_not_found');
  });

  it('is read-only once submitted (BR-4)', async () => {
    const id = await kit.draft();
    await kit.approved(id);
    const row = await get(id);
    expect(
      await codeOf(tx((t) => service().update(id, { stages }, row.version, kit.actor, t, true))),
    ).toBe('quotation_read_only');
    expect(await codeOf(tx((t) => service().remove(id, row.version, kit.actor, t)))).toBe(
      'quotation_read_only',
    );
  });

  it('deletes a draft softly', async () => {
    const id = await kit.draft();
    const row = await get(id);
    await tx((t) => service().remove(id, row.version, kit.actor, t));
    expect(await codeOf(get(id))).toBe('quotation_not_found');
    expect(await auditCount(kit.db, 'quotations.quotation.delete')).toBeGreaterThan(0);
    expect(await service().exists(kit.db, id)).toBe(false);
  });
});

describe('submission and approval (BR-2, T-2)', () => {
  it('computes the margin panel from the locked estimate and the price', async () => {
    const id = await kit.draft();
    expect((await get(id)).margin).toEqual({
      totalCost: '1000.00',
      marginAmount: '200.00',
      marginPercent: '16.6667',
      floorPercent: '0.0000',
      belowFloor: false,
    });
    expect((await get(id, false)).margin).toBeNull();
  });

  it('runs the approval engine and moves to approved on approval', async () => {
    const id = await kit.draft();
    const row = await get(id);
    const submitted = await tx((t) => service().submit(id, row.version, kit.actor, t, false));
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approval).toMatchObject({ status: 'pending', currentRole: 'management' });
    await kit.decide(id, 'approve');
    const approved = await get(id);
    expect(approved.status).toBe('approved');
    expect(approved.approval.status).toBe('approved');
    expect(approved.history.map((h) => h.toStatus)).toEqual([
      'draft',
      'pending_approval',
      'approved',
    ]);
    expect(approved.history[2]).toMatchObject({ changedBy: MANAGEMENT, note: 'approval approved' });
  });

  it('flags a margin below the floor on the approval request, at the boundary', async () => {
    const flagged = async (floor: string) => {
      const current = await kit.platform.settings.get(kit.db, 'quotations.margin_floor_percent');
      await tx((t) =>
        kit.platform.settings.set(
          {
            key: 'quotations.margin_floor_percent',
            value: floor,
            expectedVersion: current.version,
          },
          { actorUserId: ADMIN, requestId: null },
          t,
        ),
      );
      const id = await kit.draft();
      const row = await get(id);
      await tx((t) => service().submit(id, row.version, kit.actor, t, false));
      const state = await kit.approvals.getApprovalState(kit.db, 'quotation', id);
      if (state.status === 'none') throw new Error('no request');
      return state.context;
    };
    // The margin of price 1200 on cost 1000 is 16.6667.
    expect(await flagged('16.6667')).toMatchObject({
      belowMarginFloor: false,
      marginPercent: '16.6667',
      marginFloorPercent: '16.6667',
    });
    expect(await flagged('16.6668')).toMatchObject({ belowMarginFloor: true });
    await flagged('0');
  });

  it('is an error when no approval rule covers the price', async () => {
    await kit.db.query("update apr_rules set max_amount = 100 where doc_type = 'quotation'");
    try {
      const id = await kit.draft();
      const row = await get(id);
      expect(await codeOf(tx((t) => service().submit(id, row.version, kit.actor, t, false)))).toBe(
        'no_approval_rule',
      );
      expect((await get(id)).status).toBe('draft');
    } finally {
      await kit.db.query("update apr_rules set max_amount = null where doc_type = 'quotation'");
    }
  });

  it('refuses to submit twice or with a stale version', async () => {
    const id = await kit.draft();
    const row = await get(id);
    expect(
      await codeOf(tx((t) => service().submit(id, row.version + 3, kit.actor, t, false))),
    ).toBe('version_conflict');
    await tx((t) => service().submit(id, row.version, kit.actor, t, false));
    const after = await get(id);
    expect(await codeOf(tx((t) => service().submit(id, after.version, kit.actor, t, false)))).toBe(
      'quotation_transition',
    );
  });

  for (const action of ['reject', 'return'] as const) {
    it(`returns the draft when the approvers ${action} it, and it can be submitted again`, async () => {
      const id = await kit.draft();
      const row = await get(id);
      await tx((t) => service().submit(id, row.version, kit.actor, t, false));
      await kit.decide(id, action);
      const back = await get(id);
      expect(back.status).toBe('draft');
      expect(back.history.at(-1)).toMatchObject({ toStatus: 'draft', changedBy: MANAGEMENT });
      await tx((t) => service().submit(id, back.version, kit.actor, t, false));
      expect((await get(id)).status).toBe('pending_approval');
    });
  }

  it('ignores outcomes for quotations that are gone or no longer pending', async () => {
    const payload = (docId: string) => ({ docType: 'quotation', docId, requesterId: PM });
    await tx((t) => service().onApprovalOutcome('approved', payload(MISSING), t));
    const id = await kit.draft();
    await tx((t) => service().onApprovalOutcome('approved', payload(id), t));
    expect((await get(id)).status).toBe('draft');
    await kit.approved(id);
    const events = await eventCount(kit.db, 'quotations.quotation.changed');
    await tx((t) => service().onApprovalOutcome('rejected', payload(id), t));
    expect((await get(id)).status).toBe('approved');
    expect(await eventCount(kit.db, 'quotations.quotation.changed')).toBe(events);
  });

  it('attributes an outcome to the requester when the request has no action yet', async () => {
    const id = await kit.draft();
    const row = await get(id);
    await tx((t) => service().submit(id, row.version, kit.actor, t, false));
    await tx((t) =>
      service().onApprovalOutcome(
        'cancelled',
        { docType: 'quotation', docId: id, requesterId: PM },
        t,
      ),
    );
    const back = await get(id);
    expect(back.status).toBe('draft');
    expect(back.history.at(-1)?.changedBy).toBe(PM);
  });

  it('falls back to the requester when there is no approval request at all', async () => {
    const id = await kit.draft();
    await kit.db.query("update qte_quotations set status = 'pending_approval' where id = $1", [id]);
    await tx((t) =>
      service().onApprovalOutcome(
        'approved',
        { docType: 'quotation', docId: id, requesterId: PM },
        t,
      ),
    );
    expect((await get(id)).history.at(-1)?.changedBy).toBe(PM);
  });
});

describe('issue and expiry (BR-4, BR-5, T-4)', () => {
  it('sets the issue date and the inclusive expiry date, and emits quotation.issued', async () => {
    setNow(START);
    const id = await kit.draft({ validityDays: 30 });
    const before = await eventCount(kit.db, 'quotation.issued');
    await kit.issued(id);
    const issued = await get(id);
    expect(issued).toMatchObject({
      status: 'issued',
      issuedAt: '2026-10-25T10:00:00.000Z',
      expiresOn: '2026-11-24',
    });
    expect(await eventCount(kit.db, 'quotation.issued')).toBe(before + 1);
  });

  it('refuses to issue before approval or with a stale version', async () => {
    const id = await kit.draft();
    const row = await get(id);
    expect(await codeOf(tx((t) => service().issue(id, row.version, kit.actor, t, false)))).toBe(
      'quotation_transition',
    );
    await kit.approved(id);
    const approved = await get(id);
    expect(
      await codeOf(tx((t) => service().issue(id, approved.version + 1, kit.actor, t, false))),
    ).toBe('version_conflict');
  });

  it('expires only after the expiry date, and the job is idempotent', async () => {
    setNow(START);
    const id = await kit.draft({ validityDays: 30 });
    await kit.issued(id);
    setNow('2026-11-24T18:00:00Z'); // still 24 Nov in Karachi, evening
    expect(await tx((t) => service().expireDue(t))).toBe(0);
    expect((await get(id)).status).toBe('issued');
    setNow('2026-11-24T19:30:00Z'); // 25 Nov 00:30 in Karachi
    expect(await tx((t) => service().expireDue(t))).toBeGreaterThanOrEqual(1);
    const expired = await get(id);
    expect(expired.status).toBe('expired');
    expect(expired.history.at(-1)).toMatchObject({ toStatus: 'expired', changedBy: null });
    expect(await tx((t) => kit.quotations.expireDue(t))).toBe(0);
    expect(await auditCount(kit.db, 'quotations.quotation.expire')).toBeGreaterThanOrEqual(1);
    setNow(START);
  });

  it('can still be accepted on the expiry date, but not after it', async () => {
    setNow(START);
    const onTime = await kit.draft({ validityDays: 1 });
    const late = await kit.draft({ validityDays: 1 });
    await kit.issued(onTime);
    await kit.issued(late);
    setNow('2026-10-26T10:00:00Z'); // the expiry date itself
    const row = await get(onTime);
    await tx((t) =>
      service().accept(onTime, { acceptedByName: 'Client' }, row.version, kit.actor, t, false),
    );
    expect((await get(onTime)).status).toBe('accepted');
    setNow('2026-10-27T10:00:00Z'); // one day after the expiry date, job has not run
    const lateRow = await get(late);
    expect(
      await codeOf(
        tx((t) =>
          service().accept(
            late,
            { acceptedByName: 'Client' },
            lateRow.version,
            kit.actor,
            t,
            false,
          ),
        ),
      ),
    ).toBe('quotation_expired');
    setNow(START);
  });
});

describe('acceptance (BR-6, T-5, T-6)', () => {
  const accept = async (id: string, name = ' Mr Client ') => {
    const row = await get(id);
    return tx((t) =>
      service().accept(
        id,
        { acceptedByName: name, note: ' signed ' },
        row.version,
        kit.actor,
        t,
        true,
      ),
    );
  };

  it('records who accepted and when, and emits quotation.accepted once with the schedule', async () => {
    const leadId = await kit.newLead();
    const estimate = await kit.lockedEstimate({ leadId });
    const id = await kit.draft({ locationId: kit.locationId }, estimate);
    await kit.issued(id);
    const before = await eventCount(kit.db, 'quotation.accepted');
    const accepted = await accept(id);
    expect(accepted).toMatchObject({
      status: 'accepted',
      acceptedByName: 'Mr Client',
      acceptedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(accepted.history.at(-1)).toMatchObject({ toStatus: 'accepted', note: 'signed' });
    expect(await eventCount(kit.db, 'quotation.accepted')).toBe(before + 1);
    const rows = await kit.db.query<{ payload: Record<string, unknown> }>(
      "select payload from sys_outbox where type = 'quotation.accepted' and payload->>'quotationId' = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      quotationId: id,
      number: accepted.number,
      revision: 1,
      estimateId: estimate.id,
      leadId,
      partyId: kit.clientId,
      sector: 'private',
      locationId: kit.locationId,
      contractValue: '1200.00',
      acceptedAt: '2026-10-25T10:00:00.000Z',
      acceptedByName: 'Mr Client',
      stages: [
        {
          stageNo: 1,
          name: 'Advance',
          basis: 'percent',
          percent: '30.0000',
          amount: '360.00',
          conditionText: 'On signing',
        },
        {
          stageNo: 2,
          name: 'Completion',
          basis: 'percent',
          percent: '70.0000',
          amount: '840.00',
          conditionText: null,
        },
      ],
    });
    // A second acceptance is refused and emits nothing.
    expect(await codeOf(accept(id))).toBe('quotation_transition');
    expect(await eventCount(kit.db, 'quotation.accepted')).toBe(before + 1);
  });

  it('accepts a private quotation without a document and needs a name', async () => {
    const id = await kit.draft();
    await kit.issued(id);
    expect(await codeOf(accept(id, '  '))).toBe('accepted_by_required');
    expect((await accept(id)).status).toBe('accepted');
  });

  it('refuses a government quotation without the acceptance document, then accepts with it', async () => {
    const estimate = await kit.lockedEstimate({ sector: 'government' });
    const id = await kit.draft({}, estimate);
    await kit.issued(id);
    expect(await codeOf(accept(id))).toBe('acceptance_document_required');
    await kit.attachAcceptance(id);
    expect((await accept(id)).status).toBe('accepted');
  });

  it('refuses to accept before issue', async () => {
    const id = await kit.draft();
    expect(await codeOf(accept(id))).toBe('quotation_transition');
  });
});

describe('rejection and revision (BR-4, BR-10, T-3)', () => {
  it('needs a reason, and a rejected quotation can be revised', async () => {
    const id = await kit.draft();
    await kit.issued(id);
    const row = await get(id);
    expect(
      await codeOf(tx((t) => service().reject(id, '  ', row.version, kit.actor, t, true))),
    ).toBe('reason_required');
    const rejected = await tx((t) =>
      service().reject(id, ' too dear ', row.version, kit.actor, t, true),
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.history.at(-1)).toMatchObject({ toStatus: 'rejected', note: 'too dear' });
    const revision = await tx((t) => service().revise(id, kit.actor, t, true));
    expect(revision).toMatchObject({ revision: 2, status: 'draft', price: '1200.00' });
    expect(revision.stages).toHaveLength(2);
  });

  it('allows one open revision at a time, and revising only issued, rejected or expired ones', async () => {
    const id = await kit.draft();
    expect(await codeOf(tx((t) => service().revise(id, kit.actor, t, true)))).toBe(
      'quotation_not_revisable',
    );
    expect(await codeOf(tx((t) => service().revise(MISSING, kit.actor, t, true)))).toBe(
      'quotation_not_found',
    );
    await kit.issued(id);
    await tx((t) => service().revise(id, kit.actor, t, true));
    expect(await codeOf(tx((t) => service().revise(id, kit.actor, t, true)))).toBe('revision_open');
  });

  it('supersedes the old quotation when the revision is issued', async () => {
    const id = await kit.draft();
    await kit.issued(id);
    const revision = await tx((t) => service().revise(id, kit.actor, t, true));
    await kit.issued(revision.id);
    expect((await get(id)).status).toBe('superseded');
    expect((await get(revision.id)).status).toBe('issued');
    expect(await auditCount(kit.db, 'quotations.quotation.supersede')).toBeGreaterThan(0);
    // A superseded quotation cannot be revised again.
    expect(await codeOf(tx((t) => service().revise(id, kit.actor, t, true)))).toBe(
      'quotation_not_revisable',
    );
  });

  it('revises an expired quotation', async () => {
    setNow(START);
    const id = await kit.draft({ validityDays: 1 });
    await kit.issued(id);
    setNow('2026-10-28T10:00:00Z');
    await tx((t) => service().expireDue(t));
    expect((await get(id)).status).toBe('expired');
    expect((await tx((t) => service().revise(id, kit.actor, t, true))).revision).toBe(2);
    setNow(START);
  });
});

describe('print model (BR-8, BR-9, T-7)', () => {
  it('lists the company, client, schedule and price and nothing internal', async () => {
    const id = await kit.draft({ locationId: kit.locationId });
    await kit.issued(id);
    const model = await service().printModel(kit.db, id);
    expect(model.company).toMatchObject({ name: 'Synthetic Construction', address: 'Islamabad' });
    expect(model.registrations).toEqual([
      { authority: 'FBR', registrationType: 'ntn', number: 'SYNTHETIC-0001' },
    ]);
    expect(model.client).toEqual({ name: 'Synthetic Client', address: null, city: 'Lahore' });
    expect(model.quotation).toMatchObject({
      revision: 1,
      issuedOn: '2026-10-25',
      validityDays: 30,
    });
    expect(model.price).toBe('1200.00');
    expect(model.stages).toHaveLength(2);
    const text = JSON.stringify(model);
    expect(text).not.toMatch(/margin|cost|overhead|contingency/i);
    expect(text).not.toContain('1000.00');
  });

  it('prints a draft without dates and ignores registrations outside their validity', async () => {
    await tx((t) =>
      kit.masterData.company.createRegistration(
        { authority: 'pra', registrationType: 'strn', number: 'FUTURE-1', validFrom: '2030-01-01' },
        { userId: ADMIN, requestId: null },
        t,
      ),
    );
    await tx((t) =>
      kit.masterData.company.createRegistration(
        {
          authority: 'pra',
          registrationType: 'other',
          number: 'OLD-1',
          validFrom: '2020-01-01',
          validTo: '2021-01-01',
        },
        { userId: ADMIN, requestId: null },
        t,
      ),
    );
    const id = await kit.draft();
    const model = await service().printModel(kit.db, id);
    expect(model.quotation).toMatchObject({ issuedOn: null, expiresOn: null });
    expect(model.registrations.map((r) => r.number)).toEqual(['SYNTHETIC-0001']);
    expect(await codeOf(service().printModel(kit.db, MISSING))).toBe('quotation_not_found');
  });

  it('needs the company profile', async () => {
    const id = await kit.draft();
    await kit.db.query('delete from mst_company');
    try {
      expect(await codeOf(service().printModel(kit.db, id))).toBe('company_profile_missing');
    } finally {
      await tx((t) =>
        kit.masterData.company.saveCompany(
          { name: 'Synthetic Construction', address: 'Islamabad', phone: '051-1234567' },
          undefined,
          { userId: ADMIN, requestId: null },
          t,
        ),
      );
    }
  });
});

describe('list and summary', () => {
  it('filters by status, party, estimate, lead and text', async () => {
    const leadId = await kit.newLead();
    const estimate = await kit.lockedEstimate({ leadId });
    const id = await kit.draft({}, estimate);
    const row = await get(id);
    const query = { limit: 50, offset: 0 };
    expect(
      (await service().list(kit.db, { ...query, estimateId: estimate.id })).items.map((q) => q.id),
    ).toEqual([id]);
    expect((await service().list(kit.db, { ...query, leadId })).total).toBe(1);
    expect((await service().list(kit.db, { ...query, q: row.number })).total).toBe(1);
    expect((await service().list(kit.db, { ...query, q: '  ' })).total).toBeGreaterThan(1);
    expect((await service().list(kit.db, { ...query, partyId: MISSING })).total).toBe(0);
    expect(
      (await service().list(kit.db, { ...query, status: 'issued', estimateId: estimate.id })).total,
    ).toBe(0);
    const summary = await kit.quotations.getQuotation(kit.db, id);
    expect(summary).toMatchObject({ id, price: '1200.00' });
    expect(summary.stages).toHaveLength(2);
    expect(await service().exists(kit.db, id)).toBe(true);
  });
});
