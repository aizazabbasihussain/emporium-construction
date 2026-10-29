import { importerPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  SUPERVISOR,
  SUPERVISOR2,
  createWorkforceKit,
  type WorkforceKit,
} from '../test-support.js';

let kit: WorkforceKit;
const actor = { userId: ADMIN, requestId: null };
const permissions = new Set<string>(Object.values(importerPermissions));

const dryRun = (importerCode: string, ...lines: string[]) =>
  kit.importer.service.dryRun(
    {
      importerCode,
      fileName: `${importerCode}.csv`,
      content: Buffer.from(lines.join('\n') + '\n'),
    },
    actor,
    kit.db,
  );
const commit = async (importerCode: string, ...lines: string[]) => {
  const result = await dryRun(importerCode, ...lines);
  expect(result.errors).toEqual([]);
  return kit.importer.service.commit(result.batchId, { force: false, permissions }, actor, kit.db);
};

beforeAll(async () => {
  kit = await createWorkforceKit();
}, 60_000);
afterAll(() => kit.close());

describe('importers are registered (BR-9, T-6)', () => {
  it('registers one importer per table with a working template', async () => {
    const codes = kit.importer.service.listImporters().map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['workers', 'worker_pay_rates', 'teams', 'team_members']),
    );
    for (const code of ['workers', 'worker_pay_rates', 'teams', 'team_members']) {
      const template = await kit.importer.service.template(code, 'csv');
      expect(String(template.body)).toContain('\n');
    }
  });
});

describe('loading 50 synthetic workers (AC-1)', () => {
  const trades = ['mason', 'helper', 'carpenter', 'steel_fixer', 'painter'];

  it('imports workers, rates, teams and memberships that resolve by date', async () => {
    // A synthetic basis for the test; the real one is H-11 and is set by the owner.
    await kit.setSetting('workforce.working_days_basis', 26);
    const workerLines = [
      'code,full_name,father_name,cnic,phone,trade,employment_type,joined_on,bank_or_wallet_info',
    ];
    const rateLines = ['worker_code,pay_basis,amount,effective_from,effective_to'];
    const memberLines = ['team_code,worker_code,from_date,to_date'];
    for (let i = 1; i <= 50; i += 1) {
      const code = `IMP-${String(i).padStart(3, '0')}`;
      const employment = i <= 30 ? 'permanent' : 'daily';
      workerLines.push(
        `${code},Import Worker ${i},Father ${i},35202-${String(1000000 + i)}-1,0300 ${String(2000000 + i)},${trades[i % trades.length]},${employment},2026-01-01,`,
      );
      if (i <= 30) {
        rateLines.push(`${code},monthly_salary,${30000 + i},2026-01-01,`);
      } else {
        rateLines.push(`${code},daily_rate,1000,2026-01-01,2026-06-30`);
        rateLines.push(`${code},daily_rate,1100,2026-07-01,`);
      }
      memberLines.push(`${['IMP-T1', 'IMP-T2', 'IMP-T3'][i % 3]},${code},2026-01-01,`);
    }
    // Worker 9 moved from team 1 to team 2 on 1 September.
    memberLines.push('IMP-T2,IMP-009,2026-09-01,');

    expect((await commit('workers', ...workerLines)).status).toBe('committed');
    expect((await commit('worker_pay_rates', ...rateLines)).status).toBe('committed');
    expect(
      (
        await commit(
          'teams',
          'code,name,supervisor_email',
          'IMP-T1,Import team 1,supervisor@example.test',
          'IMP-T2,Import team 2,SUPERVISOR2@example.test',
          'IMP-T3,Import team 3,supervisor@example.test',
        )
      ).status,
    ).toBe('committed');
    expect((await commit('team_members', ...memberLines)).status).toBe('committed');

    const workers = kit.workforce.workers;
    const manager = await kit.actor('018f7a7a-9999-7000-8000-000000000002');
    expect(
      (await workers.list(kit.db, { text: 'IMP-', limit: 100, offset: 0 }, manager)).total,
    ).toBe(50);

    const byCode = async (code: string) =>
      (await kit.db.query<{ id: string }>('select id from lab_workers where code = $1', [code]))[0]
        ?.id as string;
    const early = await byCode('IMP-040');
    expect((await kit.workforce.getWorkerRate(kit.db, early, '2026-06-30')).amount).toBe('1000.00');
    expect((await kit.workforce.getWorkerRate(kit.db, early, '2026-07-01')).amount).toBe('1100.00');
    const salaried = await byCode('IMP-005');
    expect((await kit.workforce.getWorkerRate(kit.db, salaried, '2026-03-01')).amount).toBe(
      '30005.00',
    );

    const teams = await kit.workforce.listTeamsForSupervisor(kit.db, SUPERVISOR);
    expect(teams.map((t) => t.code).sort()).toEqual(['IMP-T1', 'IMP-T3']);
    const team1 = teams.find((t) => t.code === 'IMP-T1')?.id as string;
    const team2 = (await kit.workforce.listTeamsForSupervisor(kit.db, SUPERVISOR2))[0]
      ?.id as string;
    const nine = await byCode('IMP-009');
    const idsOn = async (team: string, date: string) =>
      (await kit.workforce.getTeamMembers(kit.db, team, date)).map((m) => m.workerId);
    expect(await idsOn(team1, '2026-08-31')).toContain(nine);
    expect(await idsOn(team1, '2026-09-01')).not.toContain(nine);
    expect(await idsOn(team2, '2026-09-01')).toContain(nine);
    expect(await idsOn(team2, '2026-08-31')).not.toContain(nine);

    // A supervisor sees only the workers of their own teams.
    const supervisor = await kit.actor(SUPERVISOR);
    const seen = await workers.list(kit.db, { limit: 200, offset: 0 }, supervisor);
    const ownTeamIds = new Set(teams.map((t) => t.id));
    for (const item of seen.items) {
      const own = (
        await kit.db.query<{ team_id: string }>(
          `select team_id from lab_team_members where worker_id = $1 and to_date is null`,
          [item.id],
        )
      ).map((row) => row.team_id);
      expect(own.some((id) => ownTeamIds.has(id))).toBe(true);
    }
    expect(seen.total).toBeGreaterThan(20);
  });

  it('reports row problems instead of loading them', async () => {
    const bad = await dryRun(
      'workers',
      'code,full_name,father_name,cnic,phone,trade,employment_type,joined_on,bank_or_wallet_info',
      'BAD-1,No Cnic,,,,mason,daily,2026-01-01,',
      'BAD-2,Bad Trade,,35202-7000000-1,,astronaut,daily,2026-01-01,',
    );
    expect(bad.errorCount).toBe(0);
    const result = await kit.importer.service
      .commit(bad.batchId, { force: false, permissions }, actor, kit.db)
      .catch((error: Error & { code?: string }) => error);
    expect(result).toBeInstanceOf(Error);
    const loaded = await kit.db.query('select 1 from lab_workers where code in ($1, $2)', [
      'BAD-1',
      'BAD-2',
    ]);
    expect(loaded).toHaveLength(0);
  });

  it('refuses rates, memberships and teams that name something unknown', async () => {
    for (const [code, lines] of [
      [
        'worker_pay_rates',
        [
          'worker_code,pay_basis,amount,effective_from,effective_to',
          'NOPE,daily_rate,5,2026-01-01,',
        ],
      ],
      ['team_members', ['team_code,worker_code,from_date,to_date', 'NOPE,IMP-001,2026-01-01,']],
      ['team_members', ['team_code,worker_code,from_date,to_date', 'IMP-T1,NOPE,2026-01-01,']],
      ['teams', ['code,name,supervisor_email', 'X-1,Team,nobody-here@example.test']],
    ] as const) {
      const dry = await dryRun(code, ...lines);
      const outcome = await kit.importer.service
        .commit(dry.batchId, { force: false, permissions }, actor, kit.db)
        .then(() => 'committed')
        .catch(() => 'refused');
      expect(outcome, code).toBe('refused');
    }
  });
});
