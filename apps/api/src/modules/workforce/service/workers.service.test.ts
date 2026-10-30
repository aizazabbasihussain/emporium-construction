import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  SUPERVISOR,
  auditCount,
  createWorkforceKit,
  eventCount,
  nextCnic,
  type WorkforceKit,
} from '../test-support.js';
import type { Actor, Db } from '../types.js';

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
const workers = () => kit.workforce.workers;

describe('trades (spec section 3)', () => {
  it('ships the editable starting list', async () => {
    const codes = (await workers().listTrades(kit.db)).map((trade) => trade.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'mason',
        'helper',
        'carpenter',
        'steel_fixer',
        'painter',
        'electrician',
        'plumber',
        'driver',
        'other',
      ]),
    );
  });

  it('creates, renames and removes a trade', async () => {
    const trade = await run(MANAGEMENT, (a, tx) =>
      workers().createTrade({ code: ' Welder ', name: ' Welder ' }, a, tx),
    );
    expect(trade).toMatchObject({ code: 'welder', name: 'Welder', version: 1 });
    const renamed = await run(MANAGEMENT, (a, tx) =>
      workers().updateTrade('welder', { name: 'Arc welder' }, 1, a, tx),
    );
    expect(renamed).toMatchObject({ name: 'Arc welder', version: 2 });
    await run(MANAGEMENT, (a, tx) => workers().removeTrade('welder', 2, a, tx));
    expect((await workers().listTrades(kit.db)).map((t) => t.code)).not.toContain('welder');
    expect(await auditCount(kit.db, 'workforce.trade.removed')).toBe(1);
  });

  it('refuses a bad code, an empty name, a duplicate and a missing trade', async () => {
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().createTrade({ code: 'a b', name: 'X' }, a, tx)),
      ),
    ).toBe('trade_code_invalid');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().createTrade({ code: 'ok1', name: ' ' }, a, tx)),
      ),
    ).toBe('trade_name_required');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().createTrade({ code: 'mason', name: 'M' }, a, tx)),
      ),
    ).toBe('trade_exists');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().updateTrade('nope', { name: 'X' }, 1, a, tx)),
      ),
    ).toBe('trade_not_found');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().updateTrade('mason', { name: ' ' }, 1, a, tx)),
      ),
    ).toBe('trade_name_required');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().updateTrade('mason', { name: 'M' }, 99, a, tx)),
      ),
    ).toBe('version_conflict');
  });

  it('keeps a trade that workers have', async () => {
    await kit.worker({ tradeCode: 'plumber' });
    expect(
      await codeOf(run(MANAGEMENT, (a, tx) => workers().removeTrade('plumber', 1, a, tx))),
    ).toBe('trade_in_use');
  });
});

describe('creating a worker (BR-1, BR-8)', () => {
  it('takes the code from the number series and normalizes CNIC and phone', async () => {
    const worker = await kit.worker({ cnic: '35201-9999999-1', phone: '+92 300 7654321' });
    expect(worker.code).toMatch(/^WK-\d{4}$/);
    expect(worker.cnic).toBe('3520199999991');
    expect(worker.phone).toBe('+923007654321');
    expect(worker.status).toBe('active');
    expect(worker.version).toBe(1);
    expect(await auditCount(kit.db, 'workforce.worker.created')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'worker.changed')).toBeGreaterThan(0);
  });

  it('accepts a code of its own', async () => {
    expect((await kit.worker({ code: 'OLD-77' })).code).toBe('OLD-77');
  });

  it('refuses a name that is only spaces, an unknown trade and a bad CNIC or phone', async () => {
    expect(await codeOf(kit.worker({ fullName: '   ' }))).toBe('full_name_required');
    expect(await codeOf(kit.worker({ tradeCode: 'astronaut' }))).toBe('trade_unknown');
    expect(await codeOf(kit.worker({ cnic: '123' }))).toBe('invalid_cnic');
    expect(await codeOf(kit.worker({ phone: 'abc' }))).toBe('invalid_phone');
    expect(await codeOf(kit.worker({ joinedOn: '2026-02-30' }))).toBe('invalid_date');
  });

  it('needs a CNIC for permanent and daily workers (T-1)', async () => {
    expect(await codeOf(kit.worker({ cnic: null, employmentType: 'permanent' }))).toBe(
      'cnic_required',
    );
    expect(await codeOf(kit.worker({ cnic: '  ', employmentType: 'daily' }))).toBe('cnic_required');
  });

  it('lets a contract worker of a labour contractor omit the CNIC, and only then (T-1)', async () => {
    const contractor = await kit.contractor();
    const worker = await kit.worker({
      cnic: null,
      employmentType: 'contract',
      contractorPartyId: contractor,
    });
    expect(worker.cnic).toBeNull();
    expect(worker.contractorPartyId).toBe(contractor);
    expect(await codeOf(kit.worker({ cnic: null, employmentType: 'contract' }))).toBe(
      'cnic_required',
    );
  });

  it('wants the contractor to be a labour contractor', async () => {
    const vendor = await kit.db.transaction((tx) =>
      kit.masterData.parties.create(
        { name: 'Synthetic Vendor', roles: ['vendor'] },
        { userId: MANAGEMENT, requestId: null },
        tx,
      ),
    );
    for (const id of [vendor.id, '018f7c7c-0000-7000-8000-00000000dead']) {
      expect(
        await codeOf(kit.worker({ cnic: null, employmentType: 'contract', contractorPartyId: id })),
      ).toBe('contractor_invalid');
    }
  });

  it('keeps a contractor with workers from being deleted in master data', async () => {
    const contractor = await kit.contractor();
    await kit.worker({ cnic: null, employmentType: 'contract', contractorPartyId: contractor });
    expect(
      await codeOf(
        kit.db.transaction((tx) =>
          kit.masterData.parties.remove(contractor, 1, { userId: MANAGEMENT, requestId: null }, tx),
        ),
      ),
    ).toBeDefined();
  });

  it('keeps a CNIC unique among active workers (T-1)', async () => {
    const cnic = nextCnic();
    const first = await kit.worker({ cnic });
    expect(await codeOf(kit.worker({ cnic }))).toBe('cnic_in_use');
    // Once the first worker has left, the CNIC can be used again.
    await run(MANAGEMENT, (a, tx) =>
      workers().deactivate(first.id, { leftOn: '2026-06-30' }, 1, a, tx),
    );
    expect((await kit.worker({ cnic })).cnic).toBe(cnic);
  });

  it('writes no full CNIC or bank detail into the audit log (BR-8)', async () => {
    const cnic = nextCnic();
    await kit.worker({ cnic, bankOrWalletInfo: 'JazzCash 03001234567' });
    const rows = await kit.db.query<{ after: unknown }>(
      `select after from sys_audit_log where action = 'workforce.worker.created'`,
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain(cnic);
    expect(text).not.toContain('03001234567');
    expect(text).toContain('4567');
  });
});

describe('changing a worker', () => {
  it('updates fields and keeps the rest', async () => {
    const worker = await kit.worker({ fatherName: 'Old' });
    const updated = await run(MANAGEMENT, (a, tx) =>
      workers().update(worker.id, { fatherName: 'New', tradeCode: 'helper' }, 1, a, tx),
    );
    expect(updated).toMatchObject({
      fatherName: 'New',
      tradeCode: 'helper',
      fullName: worker.fullName,
      cnic: worker.cnic,
      version: 2,
    });
    expect(await auditCount(kit.db, 'workforce.worker.updated')).toBeGreaterThan(0);
  });

  it('keeps an unchanged CNIC and refuses one that another active worker has', async () => {
    const a = await kit.worker();
    const b = await kit.worker();
    const same = await run(MANAGEMENT, (actor, tx) =>
      workers().update(a.id, { cnic: a.cnic }, 1, actor, tx),
    );
    expect(same.version).toBe(2);
    expect(
      await codeOf(
        run(MANAGEMENT, (actor, tx) => workers().update(b.id, { cnic: a.cnic }, 1, actor, tx)),
      ),
    ).toBe('cnic_in_use');
  });

  it('refuses a missing worker, a moved version and bad new values', async () => {
    const worker = await kit.worker();
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          workers().update('018f7c7c-0000-7000-8000-00000000dead', {}, 1, a, tx),
        ),
      ),
    ).toBe('worker_not_found');
    expect(
      await codeOf(run(MANAGEMENT, (a, tx) => workers().update(worker.id, {}, 9, a, tx))),
    ).toBe('version_conflict');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) => workers().update(worker.id, { tradeCode: 'zz' }, 1, a, tx)),
      ),
    ).toBe('trade_unknown');
    expect(
      await codeOf(
        run(MANAGEMENT, (a, tx) =>
          workers().update(
            worker.id,
            { contractorPartyId: '018f7c7c-0000-7000-8000-00000000dead' },
            1,
            a,
            tx,
          ),
        ),
      ),
    ).toBe('contractor_invalid');
  });

  it('does not check the CNIC of a worker who has left', async () => {
    const cnic = nextCnic();
    const gone = await kit.worker({ cnic });
    await run(MANAGEMENT, (a, tx) =>
      workers().deactivate(gone.id, { leftOn: '2026-05-01' }, 1, a, tx),
    );
    await kit.worker({ cnic });
    const edited = await run(MANAGEMENT, (a, tx) =>
      workers().update(gone.id, { fatherName: 'Corrected' }, 2, a, tx),
    );
    expect(edited.fatherName).toBe('Corrected');
  });
});

describe('seeing workers (BR-7, BR-8, AC-2, T-5)', () => {
  it('shows the full CNIC and bank details to those who manage workers, masked to others', async () => {
    const cnic = nextCnic();
    const created = await kit.worker({ cnic, bankOrWalletInfo: 'HBL 0123456789' });
    expect(created.cnic).toBe(cnic);
    expect(created.bankOrWalletInfo).toBe('HBL 0123456789');

    const office = await run(ACCOUNTANT, (a, tx) => workers().get(tx, created.id, a));
    expect(office.cnic).toBe(cnic);
    const pm = await kit.actor('018f7a7a-9999-7000-8000-000000000003');
    const masked = await workers().get(kit.db, created.id, pm);
    expect(masked.cnic).toBe(`*********${cnic.slice(-4)}`);
    expect(masked.bankOrWalletInfo).toBe('**********6789');
  });

  it('never puts pay into a worker, even for the accountant', async () => {
    const worker = await kit.worker();
    await run(ACCOUNTANT, (a, tx) =>
      workers().addRate(
        worker.id,
        { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' },
        a,
        tx,
      ),
    );
    const seen = await workers().get(kit.db, worker.id, await kit.actor(ACCOUNTANT));
    const keys = Object.keys(seen).join(' ').toLowerCase();
    for (const word of ['rate', 'salary', 'amount', 'wage', 'pay']) {
      expect(keys).not.toContain(word);
    }
    const listed = await workers().list(
      kit.db,
      { limit: 200, offset: 0 },
      await kit.actor(ACCOUNTANT),
    );
    for (const item of listed.items) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(seen).sort());
    }
  });

  it('lists with masked CNICs and filters by team, trade, status and text', async () => {
    const team = await kit.team();
    const mason = await kit.worker({ fullName: 'Zed Findable', tradeCode: 'painter' });
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.setMembers(team.id, { workerIds: [mason.id] }, team.version, a, tx),
    );
    const office = await kit.actor(MANAGEMENT);
    const all = await workers().list(kit.db, { limit: 500, offset: 0 }, office);
    expect(all.items.every((w) => w.cnic === null || w.cnic.startsWith('*********'))).toBe(true);
    expect(all.total).toBeGreaterThan(5);

    const byText = await workers().list(kit.db, { text: 'findable', limit: 10, offset: 0 }, office);
    expect(byText.items.map((w) => w.id)).toEqual([mason.id]);
    const byPercent = await workers().list(kit.db, { text: '%', limit: 10, offset: 0 }, office);
    expect(byPercent.total).toBe(0);
    const byTeam = await workers().list(kit.db, { teamId: team.id, limit: 10, offset: 0 }, office);
    expect(byTeam.items.map((w) => w.id)).toEqual([mason.id]);
    const byTrade = await workers().list(
      kit.db,
      { tradeCode: 'painter', limit: 500, offset: 0 },
      office,
    );
    expect(byTrade.items.every((w) => w.tradeCode === 'painter')).toBe(true);
    const inactive = await workers().list(
      kit.db,
      { status: 'inactive', limit: 500, offset: 0 },
      office,
    );
    expect(inactive.items.every((w) => w.status === 'inactive')).toBe(true);
    const page = await workers().list(kit.db, { limit: 2, offset: 2 }, office);
    expect(page).toMatchObject({ limit: 2, offset: 2 });
    expect(page.items).toHaveLength(2);
  });

  it('shows a supervisor only the workers of their teams', async () => {
    const mine = await kit.team({ supervisorUserId: SUPERVISOR });
    const other = await kit.team({ supervisorUserId: '018f7a7a-9999-7000-8000-000000000006' });
    const inMine = await kit.worker();
    const inOther = await kit.worker();
    const loose = await kit.worker();
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.setMembers(mine.id, { workerIds: [inMine.id] }, mine.version, a, tx),
    );
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.setMembers(other.id, { workerIds: [inOther.id] }, other.version, a, tx),
    );
    const supervisor = await kit.actor(SUPERVISOR);
    const listed = await workers().list(kit.db, { limit: 200, offset: 0 }, supervisor);
    expect(listed.items.map((w) => w.id)).toContain(inMine.id);
    expect(listed.items.map((w) => w.id)).not.toContain(inOther.id);
    expect(listed.items.map((w) => w.id)).not.toContain(loose.id);
    expect((await workers().get(kit.db, inMine.id, supervisor)).id).toBe(inMine.id);
    for (const hidden of [inOther.id, loose.id]) {
      expect(await codeOf(workers().get(kit.db, hidden, supervisor))).toBe('worker_not_found');
    }
    expect(
      await codeOf(workers().get(kit.db, '018f7c7c-0000-7000-8000-00000000dead', supervisor)),
    ).toBe('worker_not_found');
  });
});

describe('pay rates (BR-2, BR-3, BR-7, T-2)', () => {
  const add = (
    workerId: string,
    input: Parameters<ReturnType<typeof workers>['addRate']>[1],
    by = ACCOUNTANT,
  ) => run(by, (a, tx) => workers().addRate(workerId, input, a, tx));

  it('adds a rate and ends the open one the day before a new one (AC-3)', async () => {
    const worker = await kit.worker();
    const first = await add(worker.id, {
      payBasis: 'daily_rate',
      amount: '1000',
      effectiveFrom: '2026-01-01',
    });
    expect(first).toMatchObject({
      amount: '1000.00',
      effectiveTo: null,
      setBy: ACCOUNTANT,
      payBasis: 'daily_rate',
    });
    await add(worker.id, {
      payBasis: 'monthly_salary',
      amount: '30000.50',
      effectiveFrom: '2026-04-01',
    });
    const history = await workers().listRates(kit.db, worker.id);
    expect(history.map((r) => [r.effectiveFrom, r.effectiveTo, r.amount])).toEqual([
      ['2026-01-01', '2026-03-31', '1000.00'],
      ['2026-04-01', null, '30000.50'],
    ]);
    const audit = await kit.db.query<{ action: string }>(
      `select action from sys_audit_log where entity_id = $1 order by at, id`,
      [first.id],
    );
    expect(audit.map((row) => row.action)).toEqual([
      'workforce.rate.added',
      'workforce.rate.closed',
    ]);
  });

  it('accepts a closed period in the past and refuses overlaps', async () => {
    const worker = await kit.worker();
    await add(worker.id, {
      payBasis: 'daily_rate',
      amount: '900',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
    });
    await add(worker.id, { payBasis: 'daily_rate', amount: '950', effectiveFrom: '2026-01-01' });
    for (const [from, to] of [
      ['2025-06-01', '2025-06-30'],
      ['2025-12-31', null],
      ['2026-01-01', null],
      ['2026-02-01', '2026-02-28'],
    ] as const) {
      expect(
        await codeOf(
          add(worker.id, {
            payBasis: 'daily_rate',
            amount: '1',
            effectiveFrom: from,
            effectiveTo: to,
          }),
        ),
        `${from} ${to}`,
      ).toBe('rate_overlap');
    }
  });

  it('refuses a bad amount or period, a missing worker and a worker who has left', async () => {
    const worker = await kit.worker();
    for (const amount of ['0', '-1', 'x', '1.234']) {
      expect(
        await codeOf(
          add(worker.id, { payBasis: 'daily_rate', amount, effectiveFrom: '2026-01-01' }),
        ),
        amount,
      ).toBe('rate_amount_invalid');
    }
    expect(
      await codeOf(
        add(worker.id, {
          payBasis: 'daily_rate',
          amount: '5',
          effectiveFrom: '2026-02-01',
          effectiveTo: '2026-01-01',
        }),
      ),
    ).toBe('period_invalid');
    expect(
      await codeOf(
        add('018f7c7c-0000-7000-8000-00000000dead', {
          payBasis: 'daily_rate',
          amount: '5',
          effectiveFrom: '2026-02-01',
        }),
      ),
    ).toBe('worker_not_found');
    await run(MANAGEMENT, (a, tx) =>
      workers().deactivate(worker.id, { leftOn: '2026-03-01' }, 1, a, tx),
    );
    expect(
      await codeOf(
        add(worker.id, { payBasis: 'daily_rate', amount: '5', effectiveFrom: '2026-04-01' }),
      ),
    ).toBe('worker_inactive');
  });

  it('looks up the rate in force on any date, on the boundaries too (BR-3)', async () => {
    const worker = await kit.worker();
    await add(worker.id, { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' });
    await add(worker.id, { payBasis: 'daily_rate', amount: '1200', effectiveFrom: '2026-04-01' });
    const rate = (date: string) => kit.workforce.getWorkerRate(kit.db, worker.id, date);
    expect((await rate('2026-01-01')).amount).toBe('1000.00');
    expect((await rate('2026-03-31')).amount).toBe('1000.00');
    expect((await rate('2026-04-01')).amount).toBe('1200.00');
    expect(await rate('2030-01-01')).toMatchObject({
      payBasis: 'daily_rate',
      dailyEquivalent: '1200.0000',
      effectiveFrom: '2026-04-01',
      effectiveTo: null,
      date: '2030-01-01',
      workerId: worker.id,
    });
    expect(await codeOf(rate('2025-12-31'))).toBe('rate_not_found');
    expect(await codeOf(rate('31/12/2026'))).toBe('invalid_date');
    expect(
      await codeOf(
        kit.workforce.getWorkerRate(kit.db, '018f7c7c-0000-7000-8000-00000000dead', '2026-01-01'),
      ),
    ).toBe('worker_not_found');
  });

  it('divides a monthly salary by the working-days basis, once it is set (BR-3)', async () => {
    const worker = await kit.worker();
    await add(worker.id, {
      payBasis: 'monthly_salary',
      amount: '30000',
      effectiveFrom: '2026-01-01',
    });
    // The register default is 26 (H-11); 0 means "not set" and is refused.
    expect(
      (await kit.workforce.getWorkerRate(kit.db, worker.id, '2026-02-01')).dailyEquivalent,
    ).toBe('1153.8462');
    await kit.setSetting('workforce.working_days_basis', 0);
    expect(await codeOf(kit.workforce.getWorkerRate(kit.db, worker.id, '2026-02-01'))).toBe(
      'working_days_basis_not_set',
    );
    await kit.setSetting('workforce.working_days_basis', 26);
    const rate = await kit.workforce.getWorkerRate(kit.db, worker.id, '2026-02-01');
    expect(rate).toMatchObject({ payBasis: 'monthly_salary', dailyEquivalent: '1153.8462' });
    // A daily rate does not depend on the basis.
    await kit.setSetting('workforce.working_days_basis', 30);
    const daily = await kit.worker();
    await add(daily.id, { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' });
    expect(
      (await kit.workforce.getWorkerRate(kit.db, daily.id, '2026-02-01')).dailyEquivalent,
    ).toBe('1000.0000');
    expect(
      (await kit.workforce.getWorkerRate(kit.db, worker.id, '2026-02-01')).dailyEquivalent,
    ).toBe('1000.0000');
    await kit.setSetting('workforce.working_days_basis', 0);
  });

  it('lists the rates of a missing worker as not found', async () => {
    expect(await codeOf(workers().listRates(kit.db, '018f7c7c-0000-7000-8000-00000000dead'))).toBe(
      'worker_not_found',
    );
  });
});

describe('leaving (BR-6, T-4)', () => {
  const leave = (id: string, leftOn: string, version = 1) =>
    run(MANAGEMENT, (a, tx) => workers().deactivate(id, { leftOn }, version, a, tx));

  it('ends the open rate and the team membership on the leaving date', async () => {
    const worker = await kit.worker();
    const team = await kit.team();
    await run(ACCOUNTANT, (a, tx) =>
      workers().addRate(
        worker.id,
        { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' },
        a,
        tx,
      ),
    );
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.addMembership(
        { teamId: team.id, workerId: worker.id, fromDate: '2026-01-01' },
        a,
        tx,
      ),
    );
    kit.unapproved.asked.length = 0;
    const left = await leave(worker.id, '2026-09-30');
    expect(left).toMatchObject({ status: 'inactive', leftOn: '2026-09-30', version: 2 });
    expect(kit.unapproved.asked).toEqual([{ workerId: worker.id, upTo: '2026-09-30' }]);
    expect((await workers().listRates(kit.db, worker.id))[0]?.effectiveTo).toBe('2026-09-30');
    const members = await kit.workforce.getTeamMembers(kit.db, team.id, '2026-09-30');
    expect(members.map((m) => m.workerId)).toEqual([worker.id]);
    expect(await kit.workforce.getTeamMembers(kit.db, team.id, '2026-10-01')).toEqual([]);
    // The history stays.
    expect(await workers().listRates(kit.db, worker.id)).toHaveLength(1);
    expect(await auditCount(kit.db, 'workforce.worker.deactivated')).toBeGreaterThan(0);
  });

  it('is blocked by attendance that is not approved, naming the sheets', async () => {
    const worker = await kit.worker();
    kit.unapproved.sheets = [{ id: 'sheet-9', date: '2026-09-29' }];
    try {
      let message = '';
      try {
        await leave(worker.id, '2026-09-30');
      } catch (error) {
        expect((error as { code: string }).code).toBe('unapproved_attendance');
        message = (error as Error).message;
      }
      expect(message).toContain('sheet-9');
      expect((await workers().get(kit.db, worker.id, await kit.actor(MANAGEMENT))).status).toBe(
        'active',
      );
    } finally {
      kit.unapproved.sheets = [];
    }
  });

  it('refuses a leaving date that is before joining, or later changes', async () => {
    const worker = await kit.worker({ joinedOn: '2026-05-01' });
    expect(await codeOf(leave(worker.id, '2026-04-30'))).toBe('left_on_before_joined');
    expect(await codeOf(leave(worker.id, '2026-06-31'))).toBe('invalid_date');
    expect(await codeOf(leave(worker.id, '2026-06-30', 7))).toBe('version_conflict');
    await leave(worker.id, '2026-06-30');
    expect(await codeOf(leave(worker.id, '2026-07-31', 2))).toBe('worker_inactive');
    expect(await codeOf(leave('018f7c7c-0000-7000-8000-00000000dead', '2026-07-31'))).toBe(
      'worker_not_found',
    );
  });

  it('refuses when a rate or a membership starts after the leaving date', async () => {
    const lateRate = await kit.worker();
    await run(ACCOUNTANT, (a, tx) =>
      workers().addRate(
        lateRate.id,
        { payBasis: 'daily_rate', amount: '1', effectiveFrom: '2026-12-01' },
        a,
        tx,
      ),
    );
    expect(await codeOf(leave(lateRate.id, '2026-10-01'))).toBe('rate_starts_after_leaving');

    const lateMember = await kit.worker();
    const team = await kit.team();
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.addMembership(
        { teamId: team.id, workerId: lateMember.id, fromDate: '2026-12-01' },
        a,
        tx,
      ),
    );
    expect(await codeOf(leave(lateMember.id, '2026-10-01'))).toBe(
      'membership_starts_after_leaving',
    );
  });
});

describe('removing a worker', () => {
  it('removes a worker that was entered by mistake, but not one with history', async () => {
    const mistake = await kit.worker();
    await run(MANAGEMENT, (a, tx) => workers().remove(mistake.id, 1, a, tx));
    expect(await codeOf(workers().get(kit.db, mistake.id, await kit.actor(MANAGEMENT)))).toBe(
      'worker_not_found',
    );

    const withRate = await kit.worker();
    await run(ACCOUNTANT, (a, tx) =>
      workers().addRate(
        withRate.id,
        { payBasis: 'daily_rate', amount: '1', effectiveFrom: '2026-01-01' },
        a,
        tx,
      ),
    );
    expect(await codeOf(run(MANAGEMENT, (a, tx) => workers().remove(withRate.id, 1, a, tx)))).toBe(
      'worker_in_use',
    );

    const withTeam = await kit.worker();
    const team = await kit.team();
    await run(MANAGEMENT, (a, tx) =>
      kit.workforce.teams.addMembership(
        { teamId: team.id, workerId: withTeam.id, fromDate: '2026-01-01' },
        a,
        tx,
      ),
    );
    expect(await codeOf(run(MANAGEMENT, (a, tx) => workers().remove(withTeam.id, 1, a, tx)))).toBe(
      'worker_in_use',
    );
  });

  it('refuses a moved version', async () => {
    const worker = await kit.worker();
    expect(await codeOf(run(MANAGEMENT, (a, tx) => workers().remove(worker.id, 5, a, tx)))).toBe(
      'version_conflict',
    );
  });
});
