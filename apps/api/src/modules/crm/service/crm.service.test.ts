import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, PM, auditCount, createCrmKit, eventCount, type CrmKit } from '../test-support.js';
import type { LeadInput } from './crm.service.js';
import type { LeadDto } from '../types.js';

let kit: CrmKit;
beforeAll(async () => {
  kit = await createCrmKit();
}, 60_000);
afterAll(() => kit.close());

const service = () => kit.crm.service;
const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);
const actor = () => kit.actor;

const baseLead: LeadInput = {
  contactName: 'Bilal Ahmed',
  contactPhone: '0300 1234567',
  workType: 'new_build',
  sector: 'private',
  sourceCode: 'referral',
  expectedValue: '2500000',
};

const newLead = (overrides: Partial<LeadInput> = {}): Promise<LeadDto> =>
  tx((db) => service().createLead({ ...baseLead, ...overrides }, actor(), db));

const move = (
  lead: Pick<LeadDto, 'id' | 'version'>,
  stageCode: string,
  options: { lossReasonCode?: string; canReopen?: boolean } = {},
) =>
  tx((db) =>
    service().moveStage(
      lead.id,
      { stageCode, lossReasonCode: options.lossReasonCode },
      lead.version,
      options.canReopen ?? false,
      actor(),
      db,
    ),
  );

const createParty = (name: string, phone: string) =>
  tx((db) => kit.masterData.parties.create({ name, roles: ['client'], phone }, actor(), db));

describe('reference data (H-16 defaults)', () => {
  it('seeds the stages, sources and loss reasons', async () => {
    const reference = await service().reference(kit.db);
    expect(reference.stages.map((s) => [s.code, s.kind])).toEqual([
      ['new', 'open'],
      ['visited', 'open'],
      ['quoted', 'open'],
      ['negotiation', 'open'],
      ['won', 'won'],
      ['lost', 'lost'],
    ]);
    expect(reference.sources.map((s) => s.code)).toContain('referral');
    expect(reference.lossReasons.map((s) => s.code)).toContain('price');
  });
});

describe('creating and editing leads (BR-1, BR-6)', () => {
  it('numbers the lead from the lead series and starts it in the first open stage', async () => {
    const first = await newLead();
    const second = await newLead();
    expect(first).toMatchObject({
      number: 'LEAD-0001',
      stageCode: 'new',
      stageKind: 'open',
      contactPhone: '+923001234567',
      expectedValue: '2500000.00',
      ownerUserId: ADMIN,
      hasOverdueFollowUp: false,
      wonAt: null,
    });
    expect(second.number).toBe('LEAD-0002');
    expect(await auditCount(kit.db, 'crm.lead.create')).toBeGreaterThanOrEqual(2);
    expect(await eventCount(kit.db, 'crm.lead.changed')).toBeGreaterThanOrEqual(2);
    expect(
      (await kit.db.query('select 1 from crm_stage_history where lead_id = $1', [first.id])).length,
    ).toBe(1);
  });

  it('needs contact name and phone when no client is linked', async () => {
    await expect(newLead({ contactPhone: null })).rejects.toMatchObject({
      code: 'contact_required',
    });
    await expect(newLead({ contactName: ' ' })).rejects.toMatchObject({ code: 'contact_required' });
    await expect(newLead({ contactPhone: 'abc' })).rejects.toMatchObject({ code: 'invalid_phone' });
  });

  it('accepts a linked client without contact details', async () => {
    const party = await createParty('Linked Client', '03005550001');
    const lead = await newLead({
      partyId: party.id,
      contactName: null,
      contactPhone: null,
      expectedValue: null,
      ownerUserId: PM,
    });
    expect(lead).toMatchObject({ partyId: party.id, contactName: null, ownerUserId: PM });
    expect(lead.expectedValue).toBeNull();
  });

  it('checks sector, work type, amount, source, client and location', async () => {
    await expect(newLead({ sector: 'ngo' })).rejects.toMatchObject({ code: 'invalid_sector' });
    await expect(newLead({ workType: 'tower' })).rejects.toMatchObject({
      code: 'invalid_work_type',
    });
    await expect(newLead({ expectedValue: '12.345' })).rejects.toMatchObject({
      code: 'invalid_expected_value',
    });
    await expect(newLead({ sourceCode: ' ' })).rejects.toMatchObject({ code: 'source_required' });
    await expect(newLead({ sourceCode: 'billboard' })).rejects.toMatchObject({
      code: 'unknown_source',
    });
    await expect(
      newLead({ partyId: '018f0000-0000-7000-8000-000000000999' }),
    ).rejects.toMatchObject({ code: 'unknown_party' });
    await expect(
      newLead({ locationId: '018f0000-0000-7000-8000-000000000999' }),
    ).rejects.toMatchObject({ code: 'unknown_location' });
  });

  it('links a location from master data', async () => {
    const location = await tx((db) =>
      kit.masterData.company.createLocation(
        { name: 'F-10', region: 'islamabad', city: 'Islamabad' },
        actor(),
        db,
      ),
    );
    const lead = await newLead({ locationId: location.id, siteAddress: ' Street 4 ' });
    expect(lead).toMatchObject({ locationId: location.id, siteAddress: 'Street 4' });
  });

  it('updates an open lead and audits the change', async () => {
    const lead = await newLead();
    const updated = await tx((db) =>
      service().updateLead(
        lead.id,
        { ...baseLead, sector: 'government', expectedValue: '3000000.5', ownerUserId: PM },
        lead.version,
        actor(),
        db,
      ),
    );
    expect(updated).toMatchObject({
      sector: 'government',
      expectedValue: '3000000.50',
      ownerUserId: PM,
      version: lead.version + 1,
    });
    // Without an owner in the input the owner stays.
    const again = await tx((db) =>
      service().updateLead(lead.id, baseLead, updated.version, actor(), db),
    );
    expect(again.ownerUserId).toBe(PM);
    expect(await auditCount(kit.db, 'crm.lead.update')).toBeGreaterThanOrEqual(2);
  });

  it('reports a version conflict and a missing lead', async () => {
    const lead = await newLead();
    await expect(
      tx((db) => service().updateLead(lead.id, baseLead, lead.version + 5, actor(), db)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      tx((db) =>
        service().updateLead('018f0000-0000-7000-8000-000000000999', baseLead, 1, actor(), db),
      ),
    ).rejects.toMatchObject({ code: 'lead_not_found' });
  });

  it('deletes an open lead softly and refuses a stale version', async () => {
    const lead = await newLead();
    await expect(
      tx((db) => service().removeLead(lead.id, lead.version + 1, actor(), db)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await service().findLead(kit.db, lead.id)).toMatchObject({ id: lead.id });
    await tx((db) => service().removeLead(lead.id, lead.version, actor(), db));
    expect(await service().findLead(kit.db, lead.id)).toBeUndefined();
    await expect(service().getLead(kit.db, lead.id)).rejects.toMatchObject({
      code: 'lead_not_found',
    });
    expect(await auditCount(kit.db, 'crm.lead.delete')).toBeGreaterThanOrEqual(1);
  });
});

describe('stage rules (BR-2, BR-3, BR-8; T-1, T-4; AC-1, AC-2)', () => {
  it('moves forward and backward among open stages and records each move', async () => {
    const lead = await newLead();
    const quoted = await move(lead, 'quoted');
    const back = await move(quoted, 'visited');
    expect(back.stageCode).toBe('visited');
    const detail = await service().detail(kit.db, lead.id);
    expect(detail.history.map((h) => [h.fromStage, h.toStage])).toEqual([
      [null, 'new'],
      ['new', 'quoted'],
      ['quoted', 'visited'],
    ]);
    expect(await auditCount(kit.db, 'crm.lead.stage')).toBeGreaterThanOrEqual(2);
    expect(await eventCount(kit.db, 'crm.lead.stage_changed')).toBeGreaterThanOrEqual(2);
  });

  it('refuses the same stage, an unknown stage and an inactive stage', async () => {
    const lead = await newLead();
    await expect(move(lead, 'new')).rejects.toMatchObject({ code: 'stage_unchanged' });
    await expect(move(lead, 'nowhere')).rejects.toMatchObject({ code: 'stage_not_found' });
    await kit.db.query(`update crm_stages set active = false where code = 'negotiation'`);
    await expect(move(lead, 'negotiation')).rejects.toMatchObject({ code: 'stage_inactive' });
    await kit.db.query(`update crm_stages set active = true where code = 'negotiation'`);
  });

  it('refuses a stale version', async () => {
    const lead = await newLead();
    await expect(move({ id: lead.id, version: 99 }, 'visited')).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });

  it('rejects a lost lead without a reason and with an unknown reason (AC-2)', async () => {
    const lead = await newLead();
    await expect(move(lead, 'lost')).rejects.toMatchObject({ code: 'loss_reason_required' });
    await expect(move(lead, 'lost', { lossReasonCode: 'bad' })).rejects.toMatchObject({
      code: 'unknown_loss_reason',
    });
  });

  it('closes a lost lead with its reason and makes it read-only except notes', async () => {
    const lead = await newLead();
    const lost = await move(lead, 'lost', { lossReasonCode: 'price' });
    expect(lost).toMatchObject({ stageKind: 'lost', lossReasonCode: 'price' });
    expect(lost.lostAt).not.toBeNull();

    await expect(move(lost, 'new')).rejects.toMatchObject({ code: 'lead_closed' });
    await expect(
      tx((db) =>
        service().updateLead(
          lost.id,
          { ...baseLead, sector: 'government' },
          lost.version,
          actor(),
          db,
        ),
      ),
    ).rejects.toMatchObject({ code: 'lead_closed' });
    const noted = await tx((db) =>
      service().updateLead(
        lost.id,
        { ...baseLead, expectedValue: '2500000.00', description: 'Client went elsewhere' },
        lost.version,
        actor(),
        db,
      ),
    );
    expect(noted.description).toBe('Client went elsewhere');
    await expect(
      tx((db) => service().removeLead(lost.id, noted.version, actor(), db)),
    ).rejects.toMatchObject({ code: 'lead_closed' });
  });

  it('wins a lead that has a client and emits crm.lead.won once (AC-1, T-4)', async () => {
    const party = await createParty('Won Client', '03005550002');
    const lead = await newLead({ partyId: party.id });
    const before = await eventCount(kit.db, 'crm.lead.won');
    const won = await move(lead, 'won');
    expect(won).toMatchObject({ stageKind: 'won', partyId: party.id });
    expect(won.wonAt).not.toBeNull();
    expect(await eventCount(kit.db, 'crm.lead.won')).toBe(before + 1);
    const payload = await kit.db.query<{ payload: Record<string, unknown> }>(
      `select payload from sys_outbox where type = 'crm.lead.won' order by occurred_at desc limit 1`,
    );
    expect(payload[0]?.payload).toEqual({
      leadId: lead.id,
      partyId: party.id,
      number: lead.number,
      sector: 'private',
    });

    // Setting the same stage again is refused and emits nothing.
    await expect(move(won, 'won')).rejects.toMatchObject({ code: 'stage_unchanged' });
    await expect(move(won, 'won', { canReopen: true })).rejects.toMatchObject({
      code: 'stage_unchanged',
    });
    expect(await eventCount(kit.db, 'crm.lead.won')).toBe(before + 1);
  });

  it('creates the client from the lead contact when winning without one', async () => {
    const lead = await newLead({ contactName: 'Walk In Client', contactPhone: '03005550003' });
    const won = await move(lead, 'won');
    expect(won.partyId).not.toBeNull();
    const party = await kit.masterData.getParty(kit.db, won.partyId as string);
    expect(party).toMatchObject({
      name: 'Walk In Client',
      phone: '+923005550003',
      roles: ['client'],
    });
  });

  it('reopens only with the permission and does not emit the won event twice', async () => {
    const party = await createParty('Reopen Client', '03005550004');
    const lead = await newLead({ partyId: party.id });
    const won = await move(lead, 'won');
    const before = await eventCount(kit.db, 'crm.lead.won');
    await expect(move(won, 'negotiation')).rejects.toMatchObject({ code: 'lead_closed' });
    await expect(
      move(won, 'lost', { canReopen: true, lossReasonCode: 'price' }),
    ).rejects.toMatchObject({ code: 'reopen_to_open_stage' });
    const reopened = await move(won, 'negotiation', { canReopen: true });
    expect(reopened).toMatchObject({ stageKind: 'open', wonAt: null, lossReasonCode: null });
    const wonAgain = await move(reopened, 'won');
    expect(wonAgain.stageKind).toBe('won');
    expect(await eventCount(kit.db, 'crm.lead.won')).toBe(before);
  });

  it('refuses to start a lead when no open stage is active', async () => {
    await kit.db.query(`update crm_stages set active = false where kind = 'open'`);
    await expect(newLead()).rejects.toMatchObject({ code: 'stage_not_found' });
    await kit.db.query(`update crm_stages set active = true where kind = 'open'`);
  });

  it('does not let a wrong-stage reopen lose the loss reason of an open move', async () => {
    const lead = await newLead();
    const quoted = await move(lead, 'quoted', { lossReasonCode: 'price' });
    expect(quoted.lossReasonCode).toBeNull();
  });
});

describe('site visits (BR-7)', () => {
  it('records a visit made today or earlier', async () => {
    const lead = await newLead();
    const visit = await tx((db) =>
      service().addVisit(
        lead.id,
        { visitDate: '2026-10-25', notes: ' Plot measured ' },
        actor(),
        db,
      ),
    );
    expect(visit).toMatchObject({
      visitDate: '2026-10-25',
      notes: 'Plot measured',
      visitedBy: ADMIN,
    });
    const bare = await tx((db) =>
      service().addVisit(lead.id, { visitDate: '2026-10-01' }, actor(), db),
    );
    expect(bare.notes).toBeNull();
    const detail = await service().detail(kit.db, lead.id);
    expect(detail.visits.map((v) => v.visitDate)).toEqual(['2026-10-25', '2026-10-01']);
    expect(await service().visitExists(kit.db, visit.id)).toBe(true);
    expect(await service().visitExists(kit.db, lead.id)).toBe(false);
    expect(await eventCount(kit.db, 'crm.visit.recorded')).toBeGreaterThanOrEqual(2);
    expect(await auditCount(kit.db, 'crm.visit.create')).toBeGreaterThanOrEqual(2);
  });

  it('refuses a future date, a missing lead and a closed lead', async () => {
    const lead = await newLead();
    await expect(
      tx((db) => service().addVisit(lead.id, { visitDate: '2026-10-27' }, actor(), db)),
    ).rejects.toMatchObject({ code: 'visit_in_future' });
    await expect(
      tx((db) =>
        service().addVisit(
          '018f0000-0000-7000-8000-000000000999',
          { visitDate: '2026-10-01' },
          actor(),
          db,
        ),
      ),
    ).rejects.toMatchObject({ code: 'lead_not_found' });
    const lost = await move(lead, 'lost', { lossReasonCode: 'price' });
    await expect(
      tx((db) => service().addVisit(lost.id, { visitDate: '2026-10-01' }, actor(), db)),
    ).rejects.toMatchObject({ code: 'lead_closed' });
  });
});

describe('follow-ups (BR-4, BR-5; T-2, T-3; AC-3)', () => {
  const reminders = (userId: string) =>
    kit.db.query<{ due_at: Date; template: string; data: Record<string, unknown> }>(
      'select due_at, template, data from ntf_reminders where user_id = $1 order by created_at',
      [userId],
    );

  it('schedules the reminder for 09:00 Asia/Karachi on the due date', async () => {
    const lead = await newLead();
    const followUp = await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-10-28', note: 'Call back' }, actor(), db),
    );
    expect(followUp).toMatchObject({
      dueDate: '2026-10-28',
      status: 'open',
      assignedTo: ADMIN,
      leadNumber: lead.number,
      overdue: false,
      doneAt: null,
    });
    const scheduled = (await reminders(ADMIN)).find((r) => r.data.followUpId === followUp.id);
    expect(scheduled?.template).toBe('crm.followup.due');
    expect(scheduled?.due_at.toISOString()).toBe('2026-10-28T04:00:00.000Z');

    // On the due date the reminder is delivered as an in-app notification to the assignee.
    kit.now.current = new Date('2026-10-28T04:00:01Z');
    await kit.notifications.tickReminders(kit.db);
    const inbox = await kit.notifications.service.list(kit.db, ADMIN);
    expect(inbox.items.some((n) => n.template === 'crm.followup.due')).toBe(true);
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });

  it('assigns to another person and allows one open follow-up per assignee and date', async () => {
    const lead = await newLead();
    const first = await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-10-30', assignedTo: PM }, actor(), db),
    );
    expect(first.assignedTo).toBe(PM);
    await expect(
      tx((db) =>
        service().addFollowUp(lead.id, { dueDate: '2026-10-30', assignedTo: PM }, actor(), db),
      ),
    ).rejects.toMatchObject({ code: 'follow_up_exists' });
    // Another assignee, another date, or the same date after completion are all fine.
    await tx((db) => service().addFollowUp(lead.id, { dueDate: '2026-10-30' }, actor(), db));
    await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-10-31', assignedTo: PM }, actor(), db),
    );
    await tx((db) => service().completeFollowUp(first.id, first.version, actor(), db));
    await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-10-30', assignedTo: PM }, actor(), db),
    );
  });

  it('refuses an invalid date, a missing lead and a closed lead', async () => {
    const lead = await newLead();
    await expect(
      tx((db) => service().addFollowUp(lead.id, { dueDate: '2026-02-30' }, actor(), db)),
    ).rejects.toMatchObject({ code: 'invalid_date' });
    await expect(
      tx((db) =>
        service().addFollowUp(
          '018f0000-0000-7000-8000-000000000999',
          { dueDate: '2026-11-01' },
          actor(),
          db,
        ),
      ),
    ).rejects.toMatchObject({ code: 'lead_not_found' });
    const lost = await move(lead, 'lost', { lossReasonCode: 'price' });
    await expect(
      tx((db) => service().addFollowUp(lost.id, { dueDate: '2026-11-01' }, actor(), db)),
    ).rejects.toMatchObject({ code: 'lead_closed' });
  });

  it('flags overdue follow-ups with a fixed clock, around midnight in Karachi (BR-5)', async () => {
    const lead = await newLead();
    const followUp = await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-11-10' }, actor(), db),
    );

    kit.now.current = new Date('2026-11-10T18:59:00Z'); // 23:59 on the due date in Karachi
    expect(
      (await service().listFollowUps(kit.db, { leadId: lead.id, limit: 10, offset: 0 })).items[0]
        ?.overdue,
    ).toBe(false);
    expect((await service().getLead(kit.db, lead.id)).hasOverdueFollowUp).toBe(false);

    kit.now.current = new Date('2026-11-10T19:00:00Z'); // 00:00 on 11 Nov in Karachi
    const list = await service().listFollowUps(kit.db, { leadId: lead.id, limit: 10, offset: 0 });
    expect(list.items[0]?.overdue).toBe(true);
    expect((await service().getLead(kit.db, lead.id)).hasOverdueFollowUp).toBe(true);
    const overdueLeads = await service().listLeads(kit.db, {
      overdue: true,
      sort: 'number',
      direction: 'asc',
      limit: 100,
      offset: 0,
    });
    expect(overdueLeads.items.map((l) => l.id)).toContain(lead.id);
    expect((await service().pipeline(kit.db)).overdueFollowUps).toBeGreaterThanOrEqual(1);

    // Completing it clears the flag.
    await tx((db) => service().completeFollowUp(followUp.id, followUp.version, actor(), db));
    expect((await service().getLead(kit.db, lead.id)).hasOverdueFollowUp).toBe(false);
    const done = await service().listFollowUps(kit.db, {
      leadId: lead.id,
      status: 'done',
      limit: 10,
      offset: 0,
    });
    expect(done.items[0]).toMatchObject({ status: 'done', overdue: false });
    expect(done.items[0]?.doneAt).not.toBeNull();
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });

  it('completes a follow-up once', async () => {
    const lead = await newLead();
    const followUp = await tx((db) =>
      service().addFollowUp(lead.id, { dueDate: '2026-11-01' }, actor(), db),
    );
    await expect(
      tx((db) => service().completeFollowUp(followUp.id, followUp.version + 3, actor(), db)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const done = await tx((db) =>
      service().completeFollowUp(followUp.id, followUp.version, actor(), db),
    );
    expect(done.status).toBe('done');
    await expect(
      tx((db) => service().completeFollowUp(followUp.id, done.version, actor(), db)),
    ).rejects.toMatchObject({ code: 'follow_up_not_open' });
    await expect(
      tx((db) =>
        service().completeFollowUp('018f0000-0000-7000-8000-000000000999', 1, actor(), db),
      ),
    ).rejects.toMatchObject({ code: 'follow_up_not_found' });
    expect(await auditCount(kit.db, 'crm.followup.done')).toBeGreaterThanOrEqual(1);
    expect(await auditCount(kit.db, 'crm.followup.create')).toBeGreaterThanOrEqual(1);
    expect(await eventCount(kit.db, 'crm.followup.changed')).toBeGreaterThanOrEqual(2);
  });

  it('cancels the open follow-ups when the lead is closed', async () => {
    const lead = await newLead();
    await tx((db) => service().addFollowUp(lead.id, { dueDate: '2026-11-02' }, actor(), db));
    await move(lead, 'lost', { lossReasonCode: 'price' });
    const list = await service().listFollowUps(kit.db, { leadId: lead.id, limit: 10, offset: 0 });
    expect(list.items.map((f) => f.status)).toEqual(['cancelled']);
  });
});

describe('lists and the pipeline (BR-5, T-5; AC-4)', () => {
  it('filters, sorts and pages the lead list', async () => {
    const lead = await newLead({
      contactName: 'Zulfiqar Search Target',
      sector: 'government',
      expectedValue: '9999999',
    });
    const query = { sort: 'number' as const, direction: 'asc' as const, limit: 50, offset: 0 };
    const byText = await service().listLeads(kit.db, { ...query, q: 'zulfiqar search' });
    expect(byText.items.map((l) => l.id)).toEqual([lead.id]);
    expect(byText).toMatchObject({ total: 1, limit: 50, offset: 0 });
    const filtered = await service().listLeads(kit.db, {
      ...query,
      stageCode: 'new',
      sector: 'government',
      ownerUserId: ADMIN,
      q: '  ',
    });
    expect(filtered.items.every((l) => l.sector === 'government' && l.stageCode === 'new')).toBe(
      true,
    );
    for (const sort of ['created', 'value', 'stage'] as const) {
      const sorted = await service().listLeads(kit.db, {
        ...query,
        sort,
        direction: 'desc',
        limit: 2,
      });
      expect(sorted.items).toHaveLength(2);
    }
    const second = await service().listLeads(kit.db, { ...query, limit: 1, offset: 1 });
    expect(second.items).toHaveLength(1);
    const none = await service().listLeads(kit.db, { ...query, q: '50%_off' });
    expect(none.total).toBe(0);
    const notOverdue = await service().listLeads(kit.db, { ...query, overdue: false, limit: 5 });
    expect(notOverdue.items.length).toBeGreaterThan(0);
  });

  it('lists follow-ups by assignee', async () => {
    const mine = await service().listFollowUps(kit.db, { assignedTo: PM, limit: 50, offset: 0 });
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.items.every((f) => f.assignedTo === PM)).toBe(true);
  });

  it('adds up to the leads per stage (AC-4)', async () => {
    const pipeline = await service().pipeline(kit.db);
    const leads = await service().listLeads(kit.db, {
      sort: 'number',
      direction: 'asc',
      limit: 200,
      offset: 0,
    });
    expect(pipeline.stages.map((s) => s.stageCode)).toEqual([
      'new',
      'visited',
      'quoted',
      'negotiation',
      'won',
      'lost',
    ]);
    for (const stage of pipeline.stages) {
      expect(stage.count).toBe(leads.items.filter((l) => l.stageCode === stage.stageCode).length);
    }
    expect(pipeline.totalCount).toBe(leads.total);
    expect(pipeline.stages.reduce((n, s) => n + s.count, 0)).toBe(pipeline.totalCount);
    const cents = (v: string | null) => (v === null ? 0n : BigInt(v.replace('.', '')));
    expect(pipeline.stages.reduce((n, s) => n + cents(s.expectedValue), 0n)).toBe(
      cents(pipeline.totalExpectedValue),
    );
    expect(pipeline.stages[0]).toMatchObject({ name: 'New', kind: 'open' });
  });
});
