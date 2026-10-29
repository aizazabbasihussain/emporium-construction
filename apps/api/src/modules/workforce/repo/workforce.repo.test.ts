import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGEMENT,
  SUPERVISOR,
  createWorkforceKit,
  nextCnic,
  uid,
  type WorkforceKit,
} from '../test-support.js';
import {
  countMembers,
  countRates,
  countWorkersOfTrade,
  deleteMember,
  findActiveWorkerByCnic,
  findTeam,
  findTeamByCode,
  findTrade,
  findWorker,
  findWorkerByCode,
  insertMember,
  insertRate,
  insertTeam,
  insertTrade,
  insertWorker,
  listMembersOn,
  listMembershipsOfWorker,
  listRates,
  listTeams,
  listTeamsOfSupervisor,
  listTrades,
  countActiveTeamsOfSupervisor,
  searchWorkers,
  setMemberEnd,
  softDeleteTeam,
  softDeleteWorker,
  teamIdsOfWorker,
  updateRate,
  updateTeam,
  updateTrade,
  updateWorker,
} from './workforce.repo.js';

let kit: WorkforceKit;
beforeAll(async () => {
  kit = await createWorkforceKit();
}, 60_000);
afterAll(() => kit.close());

const AT = new Date('2026-10-25T10:00:00Z');
let n = 1000;
const newWorker = (over: Record<string, unknown> = {}) =>
  insertWorker(
    kit.db,
    {
      id: uid(n++),
      code: `REPO-${n}`,
      full_name: `Repo Worker ${n}`,
      cnic: nextCnic(),
      trade_code: 'mason',
      employment_type: 'daily',
      joined_on: '2026-01-01',
      ...over,
    },
    MANAGEMENT,
    AT,
  );
const newTeam = (over: Record<string, unknown> = {}) =>
  insertTeam(
    kit.db,
    {
      id: uid(n++),
      code: `RT-${n}`,
      name: `Repo team ${n}`,
      supervisor_user_id: SUPERVISOR,
      ...over,
    },
    MANAGEMENT,
    AT,
  );

describe('trades', () => {
  it('lists the seeded trades and inserts, finds, updates and counts', async () => {
    expect((await listTrades(kit.db)).map((t) => t.code)).toContain('mason');
    const trade = await insertTrade(kit.db, 'welder', 'Welder', MANAGEMENT, AT);
    expect(trade).toEqual({ code: 'welder', name: 'Welder', version: 1 });
    expect(await findTrade(kit.db, 'welder')).toEqual(trade);
    expect(await findTrade(kit.db, 'nothing')).toBeUndefined();
    expect(
      await updateTrade(kit.db, 'welder', 1, { name: 'Arc welder' }, MANAGEMENT, AT),
    ).toMatchObject({
      name: 'Arc welder',
      version: 2,
    });
    expect(
      await updateTrade(kit.db, 'welder', 1, { name: 'Stale' }, MANAGEMENT, AT),
    ).toBeUndefined();
    await newWorker({ trade_code: 'welder' });
    expect(await countWorkersOfTrade(kit.db, 'welder')).toBe(1);
    expect(await countWorkersOfTrade(kit.db, 'plumber')).toBe(0);
  });
});

describe('workers', () => {
  it('inserts, finds and updates with optimistic versions', async () => {
    const row = await newWorker();
    expect(row).toMatchObject({
      status: 'active',
      joined_on: '2026-01-01',
      left_on: null,
      version: 1,
    });
    expect(await findWorker(kit.db, row.id)).toEqual(row);
    expect(await findWorker(kit.db, row.id, true)).toEqual(row);
    expect(await findWorker(kit.db, uid(99999))).toBeUndefined();
    expect(await findWorkerByCode(kit.db, row.code)).toEqual(row);
    expect(await findWorkerByCode(kit.db, 'NOPE')).toBeUndefined();
    const next = await updateWorker(kit.db, row.id, 1, { full_name: 'Renamed' }, MANAGEMENT, AT);
    expect(next).toMatchObject({ full_name: 'Renamed', version: 2 });
    expect(
      await updateWorker(kit.db, row.id, 1, { full_name: 'Stale' }, MANAGEMENT, AT),
    ).toBeUndefined();
  });

  it('finds the active holder of a CNIC and ignores inactive workers', async () => {
    const row = await newWorker();
    expect((await findActiveWorkerByCnic(kit.db, row.cnic as string))?.id).toBe(row.id);
    await updateWorker(
      kit.db,
      row.id,
      1,
      { status: 'inactive', left_on: '2026-02-01' },
      MANAGEMENT,
      AT,
    );
    expect(await findActiveWorkerByCnic(kit.db, row.cnic as string)).toBeUndefined();
  });

  it('soft deletes once and only at the expected version', async () => {
    const row = await newWorker();
    expect(await softDeleteWorker(kit.db, row.id, 5, MANAGEMENT, AT)).toBe(false);
    expect(await softDeleteWorker(kit.db, row.id, 1, MANAGEMENT, AT)).toBe(true);
    expect(await findWorker(kit.db, row.id)).toBeUndefined();
    expect(await softDeleteWorker(kit.db, row.id, 2, MANAGEMENT, AT)).toBe(false);
  });

  it('searches by text, trade, status, team and team scope with a total', async () => {
    const team = await newTeam();
    const other = await newTeam();
    const a = await newWorker({ full_name: 'Zz Searchable 100%', trade_code: 'painter' });
    const b = await newWorker({ full_name: 'Zz Searchable Other', trade_code: 'driver' });
    await insertMember(
      kit.db,
      { teamId: team.id, workerId: a.id, fromDate: '2026-01-01', toDate: null },
      MANAGEMENT,
      AT,
    );
    await insertMember(
      kit.db,
      { teamId: other.id, workerId: b.id, fromDate: '2026-01-01', toDate: null },
      MANAGEMENT,
      AT,
    );
    const base = { asOf: '2026-10-25', limit: 50, offset: 0 };
    expect((await searchWorkers(kit.db, { ...base, text: 'zz searchable' })).total).toBe(2);
    expect(
      (await searchWorkers(kit.db, { ...base, text: 'Searchable 100%' })).rows.map((r) => r.id),
    ).toEqual([a.id]);
    expect((await searchWorkers(kit.db, { ...base, text: '%' })).total).toBe(1);
    expect(
      (await searchWorkers(kit.db, { ...base, text: 'Zz', tradeCode: 'driver' })).rows.map(
        (r) => r.id,
      ),
    ).toEqual([b.id]);
    expect((await searchWorkers(kit.db, { ...base, text: 'Zz', status: 'inactive' })).total).toBe(
      0,
    );
    expect(
      (await searchWorkers(kit.db, { ...base, teamId: team.id })).rows.map((r) => r.id),
    ).toEqual([a.id]);
    expect(
      (await searchWorkers(kit.db, { ...base, teamIds: [other.id] })).rows.map((r) => r.id),
    ).toEqual([b.id]);
    expect((await searchWorkers(kit.db, { ...base, teamIds: [] })).total).toBe(0);
    const paged = await searchWorkers(kit.db, { ...base, text: 'Zz', limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
    expect(await teamIdsOfWorker(kit.db, a.id, '2026-10-25')).toEqual([team.id]);
    expect(await teamIdsOfWorker(kit.db, a.id, '2025-12-31')).toEqual([]);
  });
});

describe('pay rates', () => {
  it('inserts, lists in date order, updates and counts', async () => {
    const worker = await newWorker();
    const rate = (from: string, to: string | null, id: number) =>
      insertRate(
        kit.db,
        {
          id: uid(id),
          worker_id: worker.id,
          pay_basis: 'daily_rate',
          amount: '1000',
          effective_from: from,
          effective_to: to,
          set_by: MANAGEMENT,
        },
        MANAGEMENT,
        AT,
      );
    const later = await rate('2026-07-01', null, n++);
    const earlier = await rate('2026-01-01', '2026-06-30', n++);
    expect(earlier).toMatchObject({
      amount: '1000.00',
      effective_from: '2026-01-01',
      effective_to: '2026-06-30',
    });
    expect((await listRates(kit.db, worker.id)).map((r) => r.id)).toEqual([earlier.id, later.id]);
    expect(await countRates(kit.db, worker.id)).toBe(2);
    expect(await updateRate(kit.db, later.id, 1, { amount: '1200' }, MANAGEMENT, AT)).toMatchObject(
      { amount: '1200.00', version: 2 },
    );
    expect(
      await updateRate(kit.db, later.id, 1, { amount: '1300' }, MANAGEMENT, AT),
    ).toBeUndefined();
  });
});

describe('teams and memberships', () => {
  it('inserts, finds, lists and updates teams', async () => {
    const team = await newTeam();
    expect(await findTeam(kit.db, team.id)).toEqual(team);
    expect(await findTeam(kit.db, team.id, true)).toEqual(team);
    expect(await findTeam(kit.db, uid(99998))).toBeUndefined();
    expect(await findTeamByCode(kit.db, team.code)).toEqual(team);
    expect(await findTeamByCode(kit.db, 'NOPE')).toBeUndefined();
    expect((await listTeams(kit.db)).map((t) => t.id)).toContain(team.id);
    expect((await listTeams(kit.db, [team.id])).map((t) => t.id)).toEqual([team.id]);
    expect(await listTeams(kit.db, [])).toEqual([]);
    expect((await listTeamsOfSupervisor(kit.db, SUPERVISOR)).map((t) => t.id)).toContain(team.id);
    expect(await updateTeam(kit.db, team.id, 1, { active: false }, MANAGEMENT, AT)).toMatchObject({
      active: false,
      version: 2,
    });
    expect(await updateTeam(kit.db, team.id, 1, { active: true }, MANAGEMENT, AT)).toBeUndefined();
  });

  it('counts the active teams of a supervisor and soft deletes at the expected version', async () => {
    const lonely = uid(n++);
    const before = await countActiveTeamsOfSupervisor(kit.db, lonely);
    const team = await newTeam({ supervisor_user_id: lonely });
    expect(await countActiveTeamsOfSupervisor(kit.db, lonely)).toBe(before + 1);
    expect(await softDeleteTeam(kit.db, team.id, 9, MANAGEMENT, AT)).toBe(false);
    expect(await softDeleteTeam(kit.db, team.id, 1, MANAGEMENT, AT)).toBe(true);
    expect(await countActiveTeamsOfSupervisor(kit.db, lonely)).toBe(before);
    expect(await findTeam(kit.db, team.id)).toBeUndefined();
  });

  it('inserts, lists, ends, counts and deletes membership periods', async () => {
    const team = await newTeam();
    const worker = await newWorker({ full_name: 'Member One' });
    const period = { teamId: team.id, workerId: worker.id, fromDate: '2026-03-01' };
    await insertMember(kit.db, { ...period, toDate: null }, MANAGEMENT, AT);
    expect(await countMembers(kit.db, team.id)).toBe(1);
    expect((await listMembersOn(kit.db, team.id, '2026-03-01')).map((m) => m.worker_id)).toEqual([
      worker.id,
    ]);
    expect(await listMembersOn(kit.db, team.id, '2026-02-28')).toEqual([]);
    await setMemberEnd(kit.db, period, '2026-03-31');
    expect(await listMembersOn(kit.db, team.id, '2026-04-01')).toEqual([]);
    expect(await listMembershipsOfWorker(kit.db, worker.id)).toEqual([
      expect.objectContaining({
        team_id: team.id,
        from_date: '2026-03-01',
        to_date: '2026-03-31',
        full_name: 'Member One',
      }),
    ]);
    await setMemberEnd(kit.db, period, null);
    expect((await listMembersOn(kit.db, team.id, '2030-01-01')).length).toBe(1);
    await deleteMember(kit.db, period);
    expect(await countMembers(kit.db, team.id)).toBe(0);
  });
});
