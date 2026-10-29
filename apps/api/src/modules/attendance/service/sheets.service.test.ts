import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  FRIDAY,
  MANAGEMENT,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  THURSDAY,
  auditCount,
  createAttendanceKit,
  eventCount,
  type AttendanceKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: AttendanceKit;
beforeAll(async () => {
  kit = await createAttendanceKit();
}, 120_000);
afterAll(() => kit.close());

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

const present = (workerId: string, projectId: string, over = {}) => ({
  workerId,
  status: 'present' as const,
  allocations: [{ projectId, fraction: '1' }],
  ...over,
});

const saveBy = async (userId: string, teamId: string, date: string, input: object) => {
  const actor = await kit.actorFor(userId);
  return kit.db.transaction((tx) =>
    kit.attendance.sheets.save(teamId, date, input as never, actor, tx),
  );
};

describe('happy path (AC-1)', () => {
  it('saves, submits and approves a sheet and books approved cost on the project', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    expect(saved.status).toBe('draft');
    // A supervisor never sees pay (workforce BR-7).
    expect(saved.total).toBeNull();
    expect(saved.entries[0]?.dayValue).toBeNull();
    expect(saved.entries[0]?.allocations[0]?.amount).toBeNull();
    expect(saved.approval).toEqual({
      status: 'none',
      requestId: null,
      currentRole: null,
      lastComment: null,
    });
    const submitted = await kit.submit(saved.id);
    expect(submitted.status).toBe('submitted');
    expect(submitted.approval.status).toBe('pending');
    expect(submitted.approval.currentRole).toBe('project_manager');
    await kit.decide(saved.id, 'approve');
    const sheet = await kit.get(saved.id);
    expect(sheet.status).toBe('approved');
    expect(sheet.total).toBe('2000.00');
    expect(sheet.approvedBy).toBe(PM);
    expect(sheet.approvedAt).not.toBeNull();
    const ledger = await kit.entries(setup.projectA);
    expect(ledger.map((e) => [e.status, e.amount])).toEqual([
      ['approved', '1000.00'],
      ['approved', '1000.00'],
    ]);
    expect(ledger[0]?.costCodeId).toBe(kit.codes['200']);
    expect(ledger[0]?.entryDate).toBe(FRIDAY);
    expect(await eventCount(kit.db, 'attendance.approved')).toBeGreaterThanOrEqual(1);
    expect(await auditCount(kit.db, 'attendance.sheet.approve')).toBeGreaterThanOrEqual(1);
  });

  it('shows the sheet and its pay to the accountant, and the amount in the approval request', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.submit(saved.id);
    const asAccountant = await kit.get(saved.id, ACCOUNTANT);
    expect(asAccountant.total).toBe('2000.00');
    expect(asAccountant.entries[0]).toMatchObject({
      workerCode: setup.workerA.code,
      workerName: setup.workerA.fullName,
      dayValue: '1000.00',
      overtimeValue: '0.00',
    });
    expect(asAccountant.entries[0]?.allocations[0]).toMatchObject({
      fraction: '1.0000',
      amount: '1000.00',
      costCodeId: kit.codes['200'],
    });
    const state = await kit.approvals.getApprovalState(kit.db, 'attendance_sheet', saved.id);
    expect(state).toMatchObject({
      status: 'pending',
      amount: '2000.00',
      requesterId: SUPERVISOR,
      context: { scope: { type: 'team', id: setup.teamId }, workers: 2 },
    });
  });
});

describe('saving a sheet (BR-1, BR-2, BR-3, BR-10)', () => {
  it('creates a draft, then replaces it with the version the caller saw', async () => {
    const setup = await kit.setup();
    const first = await kit.save(setup, FRIDAY, kit.body(setup));
    expect(first.entries.map((e) => e.lineNo)).toEqual([1, 2]);
    const again = await saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      version: first.version,
      entries: [present(setup.workerA.id, setup.projectA)],
    });
    expect(again.entries).toHaveLength(1);
    expect(again.version).toBeGreaterThan(first.version);
    // The worker who was dropped is free again.
    const third = await saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      version: again.version,
      entries: [present(setup.workerB.id, setup.projectA)],
    });
    expect(third.entries[0]?.workerId).toBe(setup.workerB.id);
    expect(await auditCount(kit.db, 'attendance.sheet.save')).toBeGreaterThan(0);
  });

  it('refuses a second save without the version, or with a stale one', async () => {
    const setup = await kit.setup();
    const first = await kit.save(setup, FRIDAY, kit.body(setup));
    const noVersion = saveBy(SUPERVISOR, setup.teamId, FRIDAY, kit.body(setup));
    expect(await codeOf(noVersion)).toBe('version_conflict');
    const stale = saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      ...kit.body(setup),
      version: first.version + 5,
    });
    expect(await codeOf(stale)).toBe('version_conflict');
  });

  it('rejects the whole grid when one entry is invalid and saves nothing (T-8)', async () => {
    const setup = await kit.setup();
    const bad = saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA),
        present(setup.workerB.id, setup.projectA, {
          allocations: [{ projectId: setup.projectA, fraction: '0.999' }],
        }),
      ],
    });
    expect(await codeOf(bad)).toBe('allocation_sum');
    const grid = await kit.attendance.sheets.grid(
      kit.db,
      setup.teamId,
      FRIDAY,
      await kit.actorFor(SUPERVISOR),
    );
    expect(grid.sheet).toBeNull();
    expect(grid.members.map((m) => m.workerId).sort()).toEqual(
      [setup.workerA.id, setup.workerB.id].sort(),
    );
  });

  it('keeps explicit cost codes and refuses an inactive one', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA, {
          allocations: [{ projectId: setup.projectA, fraction: '1', costCodeId: kit.codes['500'] }],
        }),
        present(setup.workerB.id, setup.projectA),
      ],
    });
    expect(saved.entries.map((e) => e.allocations[0]?.costCodeId)).toEqual([
      kit.codes['500'],
      kit.codes['200'],
    ]);
    const retired = await kit.db.transaction(async (tx) =>
      kit.masterData.costing.createCostCode(
        { code: '998', name: 'Retired synthetic code', kind: 'overhead', active: false },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    const inactive = saveBy(SUPERVISOR, setup.teamId, THURSDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA, {
          allocations: [{ projectId: setup.projectA, fraction: '1', costCodeId: retired.id }],
        }),
      ],
    });
    expect(await codeOf(inactive)).toBe('cost_code_inactive');
  });

  it('needs the labour cost code setting to name an active code', async () => {
    const setup = await kit.setup();
    await kit.setSetting('labour_cost_code', '777');
    const unknown = saveBy(SUPERVISOR, setup.teamId, FRIDAY, kit.body(setup));
    expect(await codeOf(unknown)).toBe('labour_cost_code_unknown');
    const retired = await kit.db.transaction(async (tx) =>
      kit.masterData.costing.createCostCode(
        { code: '777', name: 'Retired labour', kind: 'overhead', active: false },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    expect(await codeOf(saveBy(SUPERVISOR, setup.teamId, FRIDAY, kit.body(setup)))).toBe(
      'cost_code_inactive',
    );
    expect(retired.code).toBe('777');
    await kit.setSetting('labour_cost_code', '200');
  });

  it('limits the sheet to the supervisor of the team (BR-1) and to existing teams', async () => {
    const setup = await kit.setup();
    expect(await codeOf(saveBy(SUPERVISOR2, setup.teamId, FRIDAY, kit.body(setup)))).toBe(
      'team_not_found',
    );
    // An office role with the permission may write a sheet for any team.
    const asPm = await saveBy(PM, setup.teamId, FRIDAY, kit.body(setup));
    expect(asPm.status).toBe('draft');
    expect(
      await codeOf(saveBy(PM, '018f7c7c-0000-7000-8000-00000000dead', FRIDAY, kit.body(setup))),
    ).toBe('team_not_found');
  });

  it('refuses an inactive team', async () => {
    const setup = await kit.setup();
    const actor = await kit.actorFor(MANAGEMENT);
    const team = await kit.workforce.getTeam(kit.db, setup.teamId, actor);
    await kit.db.transaction((tx) =>
      kit.workforce.teams.update(setup.teamId, { active: false }, team.version, actor, tx),
    );
    // The supervisor loses the team scope with it, so an office role tries.
    expect(await codeOf(saveBy(PM, setup.teamId, FRIDAY, kit.body(setup)))).toBe('team_inactive');
  });

  it('refuses dates in the future and beyond the backdating allowance (T-7)', async () => {
    const setup = await kit.setup();
    expect(await codeOf(saveBy(SUPERVISOR, setup.teamId, '2026-10-26', kit.body(setup)))).toBe(
      'date_in_future',
    );
    expect(await codeOf(saveBy(SUPERVISOR, setup.teamId, '2026-10-21', kit.body(setup)))).toBe(
      'backdating_not_allowed',
    );
    expect(await codeOf(saveBy(SUPERVISOR, setup.teamId, THURSDAY, kit.body(setup)))).toBe(
      'no error',
    );
    expect(await codeOf(saveBy(SUPERVISOR, setup.teamId, 'nonsense', kit.body(setup)))).toBe(
      'invalid_date',
    );
  });

  it('does not check the date again when an existing sheet is corrected', async () => {
    const setup = await kit.setup();
    const first = await kit.save(setup, THURSDAY, kit.body(setup));
    kit.now.current = new Date('2026-10-30T10:00:00Z');
    try {
      const again = await saveBy(SUPERVISOR, setup.teamId, THURSDAY, {
        ...kit.body(setup),
        version: first.version,
      });
      expect(again.status).toBe('draft');
    } finally {
      kit.now.current = new Date('2026-10-25T10:00:00Z');
    }
  });

  it('allows only members of the team on the date, and each worker once per date (T-3)', async () => {
    const setup = await kit.setup();
    const outsider = await kit.worker();
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [present(outsider.id, setup.projectA)],
        }),
      ),
    ).toBe('worker_not_in_team');

    // A worker who joins the team on Friday is not a member on Thursday.
    const joiner = await kit.worker();
    await kit.members(setup.teamId, [setup.workerA.id, setup.workerB.id, joiner.id], FRIDAY);
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, THURSDAY, {
          entries: [present(joiner.id, setup.projectA)],
        }),
      ),
    ).toBe('worker_not_in_team');
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [present(joiner.id, setup.projectA)],
        }),
      ),
    ).toBe('no error');
  });

  it('follows a mid-month team change and refuses a worker already on another sheet', async () => {
    const setup = await kit.setup();
    const other = await kit.team(SUPERVISOR2);
    // Thursday: the worker is in the first team, and its sheet is saved.
    await kit.save(setup, THURSDAY, { entries: [present(setup.workerA.id, setup.projectA)] });
    // The worker is moved to the other team from Thursday on, so Thursday's sheet of the first team
    // now holds a worker the other team also claims.
    await kit.members(other.id, [setup.workerA.id], THURSDAY);
    const second = saveBy(SUPERVISOR2, other.id, THURSDAY, {
      entries: [present(setup.workerA.id, (await kit.project(SUPERVISOR2)).toString())],
    });
    expect(await codeOf(second)).toBe('worker_on_other_sheet');
    // On Friday the other team has them; the first team no longer does.
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [present(setup.workerA.id, setup.projectA)],
        }),
      ),
    ).toBe('worker_not_in_team');
  });

  it('allocates only to active projects the supervisor is scoped to (BR-3)', async () => {
    const setup = await kit.setup();
    const foreign = await kit.project(null);
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [present(setup.workerA.id, foreign)],
        }),
      ),
    ).toBe('project_not_found');
    // The overtime project is checked as well.
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [
            present(setup.workerA.id, setup.projectA, {
              overtimeHours: '1',
              overtimeProjectId: foreign,
            }),
          ],
        }),
      ),
    ).toBe('project_not_found');

    const actor = await kit.actorFor(PM);
    const summary = await kit.projects.getProject(kit.db, setup.projectB);
    await kit.db.transaction((tx) =>
      kit.projects.service.transition(setup.projectB, 'on_hold', summary.version, actor, tx),
    );
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          entries: [present(setup.workerA.id, setup.projectB)],
        }),
      ),
    ).toBe('project_not_active');
  });

  it('refuses to change a submitted or approved sheet', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const submitted = await kit.submit(saved.id);
    expect(
      await codeOf(
        saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
          ...kit.body(setup),
          version: submitted.version,
        }),
      ),
    ).toBe('sheet_read_only');
  });
});

describe('submitting a sheet (BR-4, BR-5, BR-6, T-2)', () => {
  it('prices a half day, overtime and an absent worker without a rate', async () => {
    const setup = await kit.setup();
    const unpaid = await kit.worker({ amount: null });
    await kit.members(setup.teamId, [setup.workerA.id, setup.workerB.id, unpaid.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA, { overtimeHours: '2' }),
        present(setup.workerB.id, setup.projectA, { status: 'half_day' }),
        { workerId: unpaid.id, status: 'absent' as const },
      ],
    });
    await kit.submit(saved.id);
    const sheet = await kit.get(saved.id, ACCOUNTANT);
    // 1000 + 2 h x (1000 / 8) x 1.5 = 375, half day 500, absent 0.
    expect(sheet.entries.map((e) => [e.dayValue, e.overtimeValue])).toEqual([
      ['1000.00', '375.00'],
      ['500.00', '0.00'],
      ['0.00', '0.00'],
    ]);
    expect(sheet.entries[0]?.allocations[0]?.amount).toBe('1375.00');
    expect(sheet.total).toBe('1875.00');
  });

  it('prices a monthly salary through its daily equivalent', async () => {
    const setup = await kit.setup();
    const salaried = await kit.worker({ payBasis: 'monthly_salary', amount: '26000' });
    await kit.members(setup.teamId, [salaried.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [present(salaried.id, setup.projectA)],
    });
    await kit.submit(saved.id);
    expect((await kit.get(saved.id, ACCOUNTANT)).total).toBe('1000.00');
  });

  it('blocks submission when a worker has no rate, naming the worker', async () => {
    const setup = await kit.setup();
    const unpaid = await kit.worker({ amount: null });
    await kit.members(setup.teamId, [unpaid.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [present(unpaid.id, setup.projectA)],
    });
    const actor = await kit.actorFor(SUPERVISOR);
    const run = kit.db.transaction((tx) =>
      kit.attendance.sheets.submit(saved.id, saved.version, actor, tx),
    );
    expect(await codeOf(run)).toBe('worker_rate_missing');
    await expect(
      kit.db.transaction((tx) => kit.attendance.sheets.submit(saved.id, saved.version, actor, tx)),
    ).rejects.toThrow(unpaid.fullName);
  });

  it('passes on other rate errors, such as an undecided working-days basis', async () => {
    const setup = await kit.setup();
    const salaried = await kit.worker({ payBasis: 'monthly_salary', amount: '26000' });
    await kit.members(setup.teamId, [salaried.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [present(salaried.id, setup.projectA)],
    });
    await kit.setSetting('workforce.working_days_basis', 0);
    try {
      expect(await codeOf(kit.submit(saved.id))).toBe('working_days_basis_not_set');
    } finally {
      await kit.setSetting('workforce.working_days_basis', 26);
    }
  });

  it('refuses an empty sheet, a stale version, a second submission and outsiders', async () => {
    const setup = await kit.setup();
    const empty = await kit.save(setup, FRIDAY, { entries: [] });
    expect(await codeOf(kit.submit(empty.id))).toBe('sheet_empty');

    const saved = await kit.save(setup, THURSDAY, kit.body(setup));
    const actor = await kit.actorFor(SUPERVISOR);
    const stale = kit.db.transaction((tx) =>
      kit.attendance.sheets.submit(saved.id, saved.version + 3, actor, tx),
    );
    expect(await codeOf(stale)).toBe('version_conflict');
    const other = await kit.actorFor(SUPERVISOR2);
    const hidden = kit.db.transaction((tx) =>
      kit.attendance.sheets.submit(saved.id, saved.version, other, tx),
    );
    expect(await codeOf(hidden)).toBe('team_not_found');
    const missing = kit.db.transaction((tx) =>
      kit.attendance.sheets.submit('018f7c7c-0000-7000-8000-00000000dead', 1, actor, tx),
    );
    expect(await codeOf(missing)).toBe('sheet_not_found');

    await kit.submit(saved.id);
    expect(await codeOf(kit.submit(saved.id))).toBe('sheet_transition');
  });

  it('checks the entries again at submission (a member who left is refused)', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const actor = await kit.actorFor(MANAGEMENT);
    const team = await kit.workforce.getTeam(kit.db, setup.teamId, actor);
    await kit.db.transaction((tx) =>
      kit.workforce.teams.setMembers(
        setup.teamId,
        { workerIds: [setup.workerA.id], date: FRIDAY },
        team.version,
        actor,
        tx,
      ),
    );
    expect(await codeOf(kit.submit(saved.id))).toBe('worker_not_in_team');
  });

  it('refuses a broken overtime multiplier setting', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.setSetting('attendance.overtime_multiplier', 'abc');
    try {
      expect(await codeOf(kit.submit(saved.id))).toBe('overtime_multiplier_invalid');
    } finally {
      await kit.setSetting('attendance.overtime_multiplier', '1.5');
    }
  });

  it('divides a worker-day across two projects exactly (AC-2)', async () => {
    const setup = await kit.setup();
    const odd = await kit.worker({ amount: '1000.01' });
    await kit.members(setup.teamId, [odd.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [
        {
          workerId: odd.id,
          status: 'present' as const,
          overtimeHours: '1',
          allocations: [
            { projectId: setup.projectA, fraction: '0.5' },
            { projectId: setup.projectB, fraction: '0.5' },
          ],
        },
      ],
    });
    await kit.submit(saved.id);
    await kit.decide(saved.id, 'approve');
    const a = await kit.entries(setup.projectA);
    const b = await kit.entries(setup.projectB);
    // Day 1000.01 splits into 500.00 and 500.01; overtime 1 h x 125.00125 x 1.5 = 187.50 joins the first.
    expect(a.map((e) => e.amount)).toEqual(['687.50']);
    expect(b.map((e) => e.amount)).toEqual(['500.01']);
  });

  it('books overtime with an explicit project as its own ledger line', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA, {
          overtimeHours: '4',
          overtimeProjectId: setup.projectB,
        }),
      ],
    });
    await kit.submit(saved.id);
    await kit.decide(saved.id, 'approve');
    expect((await kit.entries(setup.projectA)).map((e) => e.amount)).toEqual(['1000.00']);
    // 4 h x 125 x 1.5 = 750.
    expect((await kit.entries(setup.projectB)).map((e) => e.amount)).toEqual(['750.00']);
    expect((await kit.get(saved.id, ACCOUNTANT)).total).toBe('1750.00');
  });
});

describe('the approver decides (BR-6, BR-8)', () => {
  it('returns a rejected sheet to the supervisor with the comment, and approves it later', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.submit(saved.id);
    await kit.decide(saved.id, 'reject');
    const rejected = await kit.get(saved.id, SUPERVISOR);
    expect(rejected.status).toBe('rejected');
    expect(rejected.approval.lastComment).toBe('Check the second worker');
    expect(await kit.entries(setup.projectA)).toEqual([]);

    // The supervisor corrects it (a rejected sheet is editable) and submits it again.
    const fixed = await saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      version: rejected.version,
      entries: [present(setup.workerA.id, setup.projectA)],
    });
    expect(fixed.status).toBe('rejected');
    await kit.submit(saved.id);
    await kit.decide(saved.id, 'approve');
    expect((await kit.get(saved.id)).status).toBe('approved');
    expect((await kit.entries(setup.projectA)).map((e) => e.amount)).toEqual(['1000.00']);
  });

  it('treats a returned sheet like a rejected one', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.submit(saved.id);
    await kit.decide(saved.id, 'return');
    expect((await kit.get(saved.id)).status).toBe('rejected');
  });

  it('puts a sheet back to draft when its approval request is withdrawn', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.submit(saved.id);
    await kit.db.transaction((tx) =>
      kit.approvals.cancelApproval(
        {
          docType: 'attendance_sheet',
          docId: saved.id,
          reason: 'Withdrawn',
          actorUserId: SUPERVISOR,
        },
        tx,
      ),
    );
    await kit.dispatch();
    expect((await kit.get(saved.id)).status).toBe('draft');
  });

  it('ignores events it has already applied, for other documents and for unknown sheets', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const service = kit.attendance.sheets;
    // A draft sheet is not waiting for a decision.
    await kit.db.transaction((tx) =>
      service.onApprovalOutcome('approved', { docId: saved.id }, tx),
    );
    await kit.db.transaction((tx) =>
      service.onApprovalOutcome('approved', { docId: '018f7c7c-0000-7000-8000-00000000dead' }, tx),
    );
    expect((await kit.get(saved.id)).status).toBe('draft');
    expect(await kit.entries(setup.projectA)).toEqual([]);
    // An approval of another document type is not ours.
    await kit.db.transaction((tx) =>
      kit.platform.events.publish(
        { type: 'approval.approved', payload: { docType: 'expense_claim', docId: saved.id } },
        tx,
      ),
    );
    await kit.dispatch();
    expect((await kit.get(saved.id)).status).toBe('draft');
  });
});

describe('unlocking an approved sheet (BR-7, AC-3)', () => {
  it('reverses the cost, makes the sheet editable and books the corrected cost on re-approval', async () => {
    const setup = await kit.setup();
    const approved = await kit.approved(setup);
    expect(await kit.entries(setup.projectA)).toHaveLength(2);
    const actor = await kit.actorFor(PM);
    const unlocked = await kit.db.transaction((tx) =>
      kit.attendance.sheets.unlock(
        approved.id,
        { reason: ' Wrong project ' },
        approved.version,
        actor,
        tx,
      ),
    );
    expect(unlocked.status).toBe('unlocked');
    expect(unlocked.unlockReason).toBe('Wrong project');
    expect(unlocked.approvedBy).toBeNull();
    expect(unlocked.entries.map((e) => e.id)).not.toEqual(approved.entries.map((e) => e.id));
    expect(await eventCount(kit.db, 'attendance.unlocked')).toBeGreaterThan(0);
    // Reversing appends a reversing row to each chain; none of the original lines is deleted.
    const afterUnlock = await kit.entries(setup.projectA);
    expect(afterUnlock.filter((e) => e.status === 'reversed')).toHaveLength(2);

    // The supervisor fixes the allocation to project B and the sheet is approved again.
    const fixed = await saveBy(SUPERVISOR, setup.teamId, FRIDAY, {
      version: unlocked.version,
      entries: [
        present(setup.workerA.id, setup.projectB),
        present(setup.workerB.id, setup.projectB),
      ],
    });
    await kit.submit(fixed.id);
    await kit.decide(fixed.id, 'approve');
    expect((await kit.get(fixed.id)).status).toBe('approved');
    expect((await kit.entries(setup.projectB)).map((e) => [e.status, e.amount])).toEqual([
      ['approved', '1000.00'],
      ['approved', '1000.00'],
    ]);
  });

  it('can be approved again unchanged: the lines have new ids, so new entries are booked', async () => {
    const setup = await kit.setup();
    const approved = await kit.approved(setup);
    const actor = await kit.actorFor(PM);
    await kit.db.transaction((tx) =>
      kit.attendance.sheets.unlock(approved.id, { reason: 'Check' }, approved.version, actor, tx),
    );
    await kit.submit(approved.id);
    await kit.decide(approved.id, 'approve');
    const ledger = await kit.entries(setup.projectA);
    expect(ledger.filter((e) => e.status === 'approved')).toHaveLength(4);
    expect(ledger.filter((e) => e.status === 'reversed')).toHaveLength(2);
  });

  it('reverses a separate overtime line as well', async () => {
    const setup = await kit.setup();
    const approved = await kit.approved(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA, {
          overtimeHours: '2',
          overtimeProjectId: setup.projectB,
        }),
      ],
    });
    const actor = await kit.actorFor(PM);
    await kit.db.transaction((tx) =>
      kit.attendance.sheets.unlock(approved.id, { reason: 'Check' }, approved.version, actor, tx),
    );
    const b = await kit.entries(setup.projectB);
    expect(b.map((e) => e.status).sort()).toEqual(['approved', 'reversed']);
  });

  it('is refused once the wage period of the month is approved', async () => {
    const setup = await kit.setup();
    const approved = await kit.approved(setup);
    const actor = await kit.actorFor(PM);
    kit.wagePeriod.approved = 'October 2026';
    try {
      const run = kit.db.transaction((tx) =>
        kit.attendance.sheets.unlock(approved.id, { reason: 'Late' }, approved.version, actor, tx),
      );
      expect(await codeOf(run)).toBe('wage_period_approved');
      await expect(
        kit.db.transaction((tx) =>
          kit.attendance.sheets.unlock(
            approved.id,
            { reason: 'Late' },
            approved.version,
            actor,
            tx,
          ),
        ),
      ).rejects.toThrow('October 2026');
    } finally {
      kit.wagePeriod.approved = null;
    }
    expect((await kit.get(approved.id)).status).toBe('approved');
  });

  it('needs a reason, an approved sheet, the current version and a reachable sheet', async () => {
    const setup = await kit.setup();
    const approved = await kit.approved(setup);
    const actor = await kit.actorFor(PM);
    const unlock = (id: string, reason: string, version: number, who = actor) =>
      kit.db.transaction((tx) => kit.attendance.sheets.unlock(id, { reason }, version, who, tx));
    expect(await codeOf(unlock(approved.id, '   ', approved.version))).toBe('reason_required');
    expect(await codeOf(unlock(approved.id, 'x', approved.version + 4))).toBe('version_conflict');
    expect(
      await codeOf(unlock(approved.id, 'x', approved.version, await kit.actorFor(SUPERVISOR2))),
    ).toBe('team_not_found');
    const draft = await kit.save(setup, THURSDAY, kit.body(setup));
    expect(await codeOf(unlock(draft.id, 'x', draft.version))).toBe('sheet_transition');
  });
});

describe('reading sheets', () => {
  it('lists the sheets of the caller: a supervisor sees only their teams, without cost', async () => {
    const setup = await kit.setup();
    const other = await kit.team(SUPERVISOR2);
    const otherWorker = await kit.worker();
    await kit.members(other.id, [otherWorker.id]);
    const project = await kit.project(SUPERVISOR2);
    await saveBy(SUPERVISOR2, other.id, FRIDAY, { entries: [present(otherWorker.id, project)] });
    const mine = await kit.save(setup, FRIDAY, kit.body(setup));
    await kit.submit(mine.id);

    const supervisor = await kit.actorFor(SUPERVISOR);
    const page = await kit.attendance.sheets.list(
      kit.db,
      { teamId: setup.teamId, date: FRIDAY, limit: 10, offset: 0 },
      supervisor,
    );
    expect(page.items.map((s) => s.id)).toEqual([mine.id]);
    expect(page.items[0]?.total).toBeNull();
    expect(page.items[0]?.submittedAt).not.toBeNull();

    const accountant = await kit.actorFor(ACCOUNTANT);
    const all = await kit.attendance.sheets.list(
      kit.db,
      { from: FRIDAY, to: FRIDAY, status: 'submitted', limit: 100, offset: 0 },
      accountant,
    );
    expect(all.items.find((s) => s.id === mine.id)?.total).toBe('2000.00');
    const own = await kit.attendance.sheets.list(kit.db, { limit: 100, offset: 0 }, supervisor);
    expect(own.items.some((s) => s.teamId === other.id)).toBe(false);
    expect(own.items.some((s) => s.id === mine.id)).toBe(true);
  });

  it('hides the sheets of other teams from a supervisor as not found', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const other = await kit.actorFor(SUPERVISOR2);
    expect(await codeOf(kit.attendance.sheets.get(kit.db, saved.id, other))).toBe('team_not_found');
    expect(
      await codeOf(
        kit.attendance.sheets.get(kit.db, '018f7c7c-0000-7000-8000-00000000dead', other),
      ),
    ).toBe('sheet_not_found');
    expect(await codeOf(kit.attendance.sheets.grid(kit.db, setup.teamId, FRIDAY, other))).toBe(
      'team_not_found',
    );
  });

  it('gives the grid the members of the date and the saved sheet', async () => {
    const setup = await kit.setup();
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const grid = await kit.attendance.sheets.grid(
      kit.db,
      setup.teamId,
      FRIDAY,
      await kit.actorFor(SUPERVISOR),
    );
    expect(grid.sheet?.id).toBe(saved.id);
    expect(grid.members.map((m) => m.code).sort()).toEqual(
      [setup.workerA.code, setup.workerB.code].sort(),
    );
    expect(grid.members[0]).toMatchObject({ tradeCode: 'mason' });
  });
});
