import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGEMENT,
  PM,
  STOREKEEPER,
  SUPERVISOR,
  SUPERVISOR2,
  auditCount,
  createWorkforceKit,
  eventCount,
  type WorkforceKit,
} from '../test-support.js';
import type { Actor, Db } from '../types.js';
import { insertTeam } from '../repo/workforce.repo.js';

let kit: WorkforceKit;
beforeAll(async () => {
  kit = await createWorkforceKit();
}, 60_000);
afterAll(() => kit.close());

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const run = async <T>(by: string, fn: (actor: Actor, tx: Db) => Promise<T>) => {
  const actor = await kit.actor(by);
  return kit.db.transaction((tx) => fn(actor, tx));
};
const teams = () => kit.workforce.teams;

const teamScopes = async (userId: string) =>
  (await kit.actor(userId)).scopes.filter((scope) => scope.type === 'team').map((s) => s.id);

const setMembers = (teamId: string, workerIds: string[], version: number, date?: string) =>
  run(MANAGEMENT, (a, tx) => teams().setMembers(teamId, { workerIds, date }, version, a, tx));

describe('creating a team (BR-5)', () => {
  it('takes the code from the series and gives the supervisor the team scope', async () => {
    const team = await kit.team({ name: ' Block A masons ', supervisorUserId: SUPERVISOR2 });
    expect(team).toMatchObject({
      name: 'Block A masons',
      supervisorUserId: SUPERVISOR2,
      active: true,
      version: 1,
    });
    expect(team.code).toMatch(/^TM-\d{3}$/);
    expect(await teamScopes(SUPERVISOR2)).toContain(team.id);
    expect(await auditCount(kit.db, 'workforce.team.created')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'team.membership.changed')).toBeGreaterThan(0);
  });

  it('accepts a code of its own', async () => {
    expect((await kit.team({ code: 'NORTH' })).code).toBe('NORTH');
  });

  it('wants a name and a supervisor who is an active user with the supervisor role', async () => {
    expect(await codeOf(kit.team({ name: '  ' }))).toBe('team_name_required');
    expect(await codeOf(kit.team({ supervisorUserId: STOREKEEPER }))).toBe('supervisor_invalid');
    expect(await codeOf(kit.team({ supervisorUserId: PM }))).toBe('supervisor_invalid');
    expect(
      await codeOf(kit.team({ supervisorUserId: '018f7c7c-0000-7000-8000-00000000dead' })),
    ).toBe('supervisor_invalid');
  });

  it('refuses a supervisor whose account is disabled', async () => {
    await kit.db.query(`update sys_users set status = 'disabled' where id = $1`, [SUPERVISOR2]);
    try {
      expect(await codeOf(kit.team({ supervisorUserId: SUPERVISOR2 }))).toBe('supervisor_invalid');
    } finally {
      await kit.db.query(`update sys_users set status = 'active' where id = $1`, [SUPERVISOR2]);
    }
  });

  it('lets a supervisor have several teams', async () => {
    const a = await kit.team({ supervisorUserId: SUPERVISOR });
    const b = await kit.team({ supervisorUserId: SUPERVISOR });
    const scopes = await teamScopes(SUPERVISOR);
    expect(scopes).toEqual(expect.arrayContaining([a.id, b.id]));
    const mine = await teams().listTeamsForSupervisor(kit.db, SUPERVISOR);
    expect(mine.map((t) => t.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe('changing a team', () => {
  it('renames it and keeps the scope', async () => {
    const team = await kit.team({ supervisorUserId: SUPERVISOR2 });
    const renamed = await run(MANAGEMENT, (a, tx) =>
      teams().update(team.id, { name: 'Renamed' }, 1, a, tx),
    );
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2 });
    expect(await teamScopes(SUPERVISOR2)).toContain(team.id);
  });

  it('moves the scope when the supervisor changes', async () => {
    const team = await kit.team({ supervisorUserId: SUPERVISOR });
    await run(MANAGEMENT, (a, tx) =>
      teams().update(team.id, { supervisorUserId: SUPERVISOR2 }, 1, a, tx),
    );
    expect(await teamScopes(SUPERVISOR)).not.toContain(team.id);
    expect(await teamScopes(SUPERVISOR2)).toContain(team.id);
  });

  it('takes the scope away when the team is deactivated, and gives it back', async () => {
    const team = await kit.team({ supervisorUserId: SUPERVISOR2 });
    await run(MANAGEMENT, (a, tx) => teams().update(team.id, { active: false }, 1, a, tx));
    expect(await teamScopes(SUPERVISOR2)).not.toContain(team.id);
    await run(MANAGEMENT, (a, tx) => teams().update(team.id, { active: true }, 2, a, tx));
    expect(await teamScopes(SUPERVISOR2)).toContain(team.id);
  });

  it('refuses a missing team, a bad name or supervisor and a moved version', async () => {
    const team = await kit.team();
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          teams().update('018f7c7c-0000-7000-8000-00000000dead', {}, 1, a, tx),
        ),
      ),
    ).toBe('team_not_found');
    expect(
      await codeOf(run(MANAGEMENT, (a, tx) => teams().update(team.id, { name: ' ' }, 1, a, tx))),
    ).toBe('team_name_required');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => teams().update(team.id, { supervisorUserId: PM }, 1, a, tx)),
      ),
    ).toBe('supervisor_invalid');
    expect(await codeOf(run(MANAGEMENT, (a, tx) => teams().update(team.id, {}, 9, a, tx)))).toBe(
      'version_conflict',
    );
  });

  it('removes an empty team and keeps one with members or history', async () => {
    const empty = await kit.team({ supervisorUserId: SUPERVISOR2 });
    await run(MANAGEMENT, (a, tx) => teams().remove(empty.id, 1, a, tx));
    expect(await teamScopes(SUPERVISOR2)).not.toContain(empty.id);
    expect(await codeOf(run(MANAGEMENT, (a, tx) => teams().get(tx, empty.id, a)))).toBe(
      'team_not_found',
    );

    const used = await kit.team();
    const worker = await kit.worker();
    await setMembers(used.id, [worker.id], 1);
    expect(await codeOf(run(MANAGEMENT, (a, tx) => teams().remove(used.id, 2, a, tx)))).toBe(
      'team_in_use',
    );
    const spare = await kit.team();
    expect(await codeOf(run(MANAGEMENT, (a, tx) => teams().remove(spare.id, 7, a, tx)))).toBe(
      'version_conflict',
    );
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          teams().remove('018f7c7c-0000-7000-8000-00000000dead', 1, a, tx),
        ),
      ),
    ).toBe('team_not_found');
  });
});

describe('team membership (BR-4, T-3)', () => {
  it('puts workers in a team from today and lists them', async () => {
    const team = await kit.team();
    const [a, b] = [
      await kit.worker({ fullName: 'Aaa Worker' }),
      await kit.worker({ fullName: 'Bbb Worker' }),
    ];
    const result = await setMembers(team.id, [b.id, a.id], 1);
    expect(result.version).toBe(2);
    expect(result.members.map((m) => [m.workerId, m.fromDate, m.toDate])).toEqual([
      [a.id, '2026-10-25', null],
      [b.id, '2026-10-25', null],
    ]);
    expect(await auditCount(kit.db, 'workforce.team.members_changed')).toBeGreaterThan(0);
  });

  it('moving a worker ends the old membership the day before', async () => {
    const from = await kit.team();
    const to = await kit.team();
    const worker = await kit.worker();
    await setMembers(from.id, [worker.id], 1, '2026-09-01');
    await setMembers(to.id, [worker.id], 1, '2026-10-01');
    expect(
      (await kit.workforce.getTeamMembers(kit.db, from.id, '2026-09-30')).map((m) => m.workerId),
    ).toEqual([worker.id]);
    expect(await kit.workforce.getTeamMembers(kit.db, from.id, '2026-10-01')).toEqual([]);
    expect(
      (await kit.workforce.getTeamMembers(kit.db, to.id, '2026-10-01')).map((m) => m.workerId),
    ).toEqual([worker.id]);
    expect(await kit.workforce.getTeamMembers(kit.db, to.id, '2026-09-30')).toEqual([]);
  });

  it('leaving a worker out ends the membership the day before', async () => {
    const team = await kit.team();
    const [a, b] = [await kit.worker(), await kit.worker()];
    await setMembers(team.id, [a.id, b.id], 1, '2026-09-01');
    const after = await setMembers(team.id, [a.id], 2, '2026-10-10');
    expect(after.members.map((m) => m.workerId)).toEqual([a.id]);
    expect(
      (await kit.workforce.getTeamMembers(kit.db, team.id, '2026-10-09'))
        .map((m) => m.workerId)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('drops a membership that only starts on the same day', async () => {
    const team = await kit.team();
    const worker = await kit.worker();
    await setMembers(team.id, [worker.id], 1);
    const after = await setMembers(team.id, [], 2);
    expect(after.members).toEqual([]);
    const rows = await kit.db.query('select 1 from lab_team_members where team_id = $1', [team.id]);
    expect(rows).toHaveLength(0);
  });

  it('keeps a worker already in the team where they are', async () => {
    const team = await kit.team();
    const worker = await kit.worker();
    await setMembers(team.id, [worker.id], 1, '2026-09-01');
    await setMembers(team.id, [worker.id], 2, '2026-10-01');
    const rows = await kit.db.query('select 1 from lab_team_members where team_id = $1', [team.id]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a missing team, a stale version, an inactive team and an unknown or departed worker', async () => {
    const team = await kit.team();
    const worker = await kit.worker();
    expect(await codeOf(setMembers('018f7c7c-0000-7000-8000-00000000dead', [], 1))).toBe(
      'team_not_found',
    );
    expect(await codeOf(setMembers(team.id, [worker.id], 9))).toBe('version_conflict');
    expect(await codeOf(setMembers(team.id, ['018f7c7c-0000-7000-8000-00000000dead'], 1))).toBe(
      'worker_not_found',
    );
    expect(await codeOf(setMembers(team.id, [worker.id], 1, '2026-13-01'))).toBe('invalid_date');
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.workers.deactivate(worker.id, { leftOn: '2026-10-01' }, 1, a, tx),
    );
    expect(await codeOf(setMembers(team.id, [worker.id], 1))).toBe('worker_inactive');
    await run(MANAGEMENT, (a, tx) => teams().update(team.id, { active: false }, 1, a, tx));
    expect(await codeOf(setMembers(team.id, [], 2))).toBe('team_inactive');
  });

  it('refuses a membership that overlaps another team period', async () => {
    const one = await kit.team();
    const two = await kit.team();
    const worker = await kit.worker();
    await setMembers(one.id, [worker.id], 1, '2026-12-01');
    // Team one holds the worker from December, so a closed period inside it overlaps.
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          teams().addMembership(
            { teamId: two.id, workerId: worker.id, fromDate: '2026-12-10', toDate: '2026-12-20' },
            a,
            tx,
          ),
        ),
      ),
    ).toBe('membership_overlap');
    // Taking the worker for today would clash with the December start in the future.
    expect(await codeOf(setMembers(two.id, [worker.id], 1))).toBe('membership_overlap');
  });

  it('loads closed periods and finds them by date', async () => {
    const team = await kit.team();
    const worker = await kit.worker();
    await run(MANAGEMENT, (a, tx) =>
      teams().addMembership(
        { teamId: team.id, workerId: worker.id, fromDate: '2026-01-01', toDate: '2026-03-31' },
        a,
        tx,
      ),
    );
    expect(await kit.workforce.getTeamMembers(kit.db, team.id, '2026-03-31')).toHaveLength(1);
    expect(await kit.workforce.getTeamMembers(kit.db, team.id, '2026-04-01')).toHaveLength(0);
    expect(
      await codeOf(
        kit.workforce.getTeamMembers(kit.db, '018f7c7c-0000-7000-8000-00000000dead', '2026-04-01'),
      ),
    ).toBe('team_not_found');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          teams().addMembership(
            {
              teamId: '018f7c7c-0000-7000-8000-00000000dead',
              workerId: worker.id,
              fromDate: '2026-04-01',
            },
            a,
            tx,
          ),
        ),
      ),
    ).toBe('team_not_found');
  });
});

describe('seeing teams (AC-2)', () => {
  it('lets a supervisor see only their own teams and members', async () => {
    const mine = await kit.team({ supervisorUserId: SUPERVISOR });
    const theirs = await kit.team({ supervisorUserId: SUPERVISOR2 });
    const worker = await kit.worker();
    await setMembers(mine.id, [worker.id], 1);
    const supervisor = await kit.actor(SUPERVISOR);
    expect((await teams().list(kit.db, supervisor)).map((t) => t.id)).toContain(mine.id);
    expect((await teams().list(kit.db, supervisor)).map((t) => t.id)).not.toContain(theirs.id);
    const detail = await teams().get(kit.db, mine.id, supervisor);
    expect(detail.members.map((m) => m.workerId)).toEqual([worker.id]);
    expect(await codeOf(teams().get(kit.db, theirs.id, supervisor))).toBe('team_not_found');
    expect(Object.keys(detail.members[0] ?? {}).join(' ')).not.toMatch(/rate|salary|amount|pay/i);
  });

  it('lists every team for an office role', async () => {
    const all = await teams().list(kit.db, await kit.actor(MANAGEMENT));
    expect(all.length).toBeGreaterThan(5);
  });

  it('gives a supervisor their active teams with members on "mine", and nothing to anyone else', async () => {
    const active = await kit.team({ supervisorUserId: SUPERVISOR2 });
    const worker = await kit.worker();
    await setMembers(active.id, [worker.id], 1);
    const quiet = await kit.team({ supervisorUserId: SUPERVISOR2 });
    await run(MANAGEMENT, (a, tx) => teams().update(quiet.id, { active: false }, 1, a, tx));
    const mine = await teams().mine(kit.db, await kit.actor(SUPERVISOR2));
    expect(mine.map((t) => t.id)).toContain(active.id);
    expect(mine.map((t) => t.id)).not.toContain(quiet.id);
    expect(mine.find((t) => t.id === active.id)?.members).toHaveLength(1);
    expect(await teams().mine(kit.db, await kit.actor(MANAGEMENT))).toEqual([]);
  });
});

describe('a team whose supervisor no longer exists', () => {
  it('can still be deactivated; there are no scopes to sync', async () => {
    const ghost = '018f7a7a-9999-7000-8000-00000000ffff';
    const row = await insertTeam(
      kit.db,
      {
        id: '018f7a7a-9999-7000-8000-00000000fffe',
        code: 'GHOST',
        name: 'Ghost',
        supervisor_user_id: ghost,
      },
      MANAGEMENT,
      new Date('2026-10-25T10:00:00Z'),
    );
    const updated = await run(MANAGEMENT, (a, tx) =>
      teams().update(row.id, { active: false }, row.version, a, tx),
    );
    expect(updated.active).toBe(false);
  });
});
