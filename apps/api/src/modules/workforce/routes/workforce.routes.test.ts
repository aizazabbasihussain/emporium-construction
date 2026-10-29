import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  createWorkforceKit,
  nextCnic,
  type WorkforceKit,
} from '../test-support.js';
import type {
  PageResult,
  RateDto,
  TeamDetailDto,
  TeamDto,
  TradeDto,
  WorkerDto,
  WorkerRateDto,
} from '../types.js';

let kit: WorkforceKit;
beforeAll(async () => {
  kit = await createWorkforceKit();
  await kit.setSetting('workforce.working_days_basis', 26);
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = MANAGEMENT, body, key }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json<unknown>(),
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let keyCounter = 0;
const newKey = () => `wf-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const workerBody = (over: Record<string, unknown> = {}) => ({
  fullName: 'Route Worker',
  cnic: nextCnic(),
  tradeCode: 'mason',
  employmentType: 'daily',
  joinedOn: '2026-01-01',
  ...over,
});
const createWorker = async (over: Record<string, unknown> = {}) =>
  (await call({ method: 'POST', url: '/workforce/workers', body: workerBody(over) }))
    .body as WorkerDto;

describe('authentication and permissions', () => {
  it('refuses anonymous callers and callers without the permission', async () => {
    expect((await kit.app.inject({ method: 'GET', url: '/workforce/workers' })).statusCode).toBe(
      401,
    );
    const worker = await createWorker();
    const team = await kit.team();
    const probes: Omit<Call, 'user'>[] = [
      { method: 'GET', url: '/workforce/trades' },
      { method: 'POST', url: '/workforce/trades', body: { code: 'x', name: 'X' } },
      { method: 'PATCH', url: '/workforce/trades/mason', body: { name: 'X', version: 1 } },
      { method: 'DELETE', url: '/workforce/trades/mason?version=1' },
      { method: 'GET', url: '/workforce/workers' },
      { method: 'POST', url: '/workforce/workers', body: workerBody() },
      { method: 'GET', url: `/workforce/workers/${worker.id}` },
      { method: 'PATCH', url: `/workforce/workers/${worker.id}`, body: { version: 1 } },
      {
        method: 'POST',
        url: `/workforce/workers/${worker.id}/deactivate`,
        body: { leftOn: '2026-02-01', version: 1 },
      },
      { method: 'DELETE', url: `/workforce/workers/${worker.id}?version=1` },
      { method: 'GET', url: `/workforce/workers/${worker.id}/rates` },
      {
        method: 'POST',
        url: `/workforce/workers/${worker.id}/rates`,
        body: { payBasis: 'daily_rate', amount: '1', effectiveFrom: '2026-01-01' },
      },
      { method: 'GET', url: `/workforce/workers/${worker.id}/rate?date=2026-01-01` },
      { method: 'GET', url: '/workforce/teams' },
      { method: 'GET', url: '/workforce/teams/mine' },
      {
        method: 'POST',
        url: '/workforce/teams',
        body: { name: 'T', supervisorUserId: SUPERVISOR },
      },
      { method: 'GET', url: `/workforce/teams/${team.id}` },
      { method: 'PATCH', url: `/workforce/teams/${team.id}`, body: { version: 1 } },
      { method: 'DELETE', url: `/workforce/teams/${team.id}?version=1` },
      {
        method: 'PUT',
        url: `/workforce/teams/${team.id}/members`,
        body: { workerIds: [], version: 1 },
      },
    ];
    for (const probe of probes) {
      const denied = await call({ ...probe, user: NOBODY });
      expect(denied.status, `${probe.method} ${probe.url}`).toBe(403);
    }
  });

  it('keeps pay and management away from supervisors, rates and team changes from the office (BR-7)', async () => {
    const worker = await createWorker();
    const team = await kit.team();
    const denied: Call[] = [
      { method: 'POST', url: '/workforce/workers', body: workerBody(), user: SUPERVISOR },
      { method: 'GET', url: `/workforce/workers/${worker.id}/rates`, user: SUPERVISOR },
      { method: 'GET', url: `/workforce/workers/${worker.id}/rate?date=2026-01-01`, user: PM },
      {
        method: 'POST',
        url: `/workforce/workers/${worker.id}/rates`,
        user: PM,
        body: { payBasis: 'daily_rate', amount: '1', effectiveFrom: '2026-01-01' },
      },
      {
        method: 'POST',
        url: '/workforce/teams',
        user: ACCOUNTANT,
        body: { name: 'T', supervisorUserId: SUPERVISOR },
      },
      {
        method: 'PUT',
        url: `/workforce/teams/${team.id}/members`,
        user: SUPERVISOR,
        body: { workerIds: [], version: 1 },
      },
    ];
    for (const probe of denied) {
      expect((await call(probe)).status, `${probe.method} ${probe.url}`).toBe(403);
    }
  });
});

describe('trades', () => {
  it('lists, creates, renames and removes a trade', async () => {
    const list = await call({ method: 'GET', url: '/workforce/trades', user: SUPERVISOR });
    expect((list.body as TradeDto[]).map((t) => t.code)).toContain('mason');
    const created = await call({
      method: 'POST',
      url: '/workforce/trades',
      body: { code: 'tiler', name: 'Tiler' },
    });
    expect(created.status).toBe(201);
    const renamed = await call({
      method: 'PATCH',
      url: '/workforce/trades/tiler',
      body: { name: 'Tile fixer', version: 1 },
    });
    expect(renamed.body).toMatchObject({ name: 'Tile fixer', version: 2 });
    const stale = await call({
      method: 'PATCH',
      url: '/workforce/trades/tiler',
      body: { name: 'Stale', version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    expect(
      (await call({ method: 'DELETE', url: '/workforce/trades/tiler?version=2' })).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: '/workforce/trades/tiler?version=2' })).status,
    ).toBe(404);
  });

  it('validates the input and keeps a trade that is in use', async () => {
    for (const body of [{ code: '', name: 'X' }, { code: 'x' }, { code: 'x', name: '' }]) {
      expect((await call({ method: 'POST', url: '/workforce/trades', body })).status).toBe(400);
    }
    expect(
      (await call({ method: 'PATCH', url: '/workforce/trades/mason', body: { name: 'X' } })).status,
    ).toBe(400);
    expect((await call({ method: 'DELETE', url: '/workforce/trades/mason' })).status).toBe(400);
    const dup = await call({
      method: 'POST',
      url: '/workforce/trades',
      body: { code: 'mason', name: 'Again' },
    });
    expect(errorCode(dup)).toBe('trade_exists');
    await createWorker({ tradeCode: 'plumber' });
    const inUse = await call({ method: 'DELETE', url: '/workforce/trades/plumber?version=1' });
    expect(errorCode(inUse)).toBe('trade_in_use');
  });
});

describe('workers', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const body = workerBody();
    const key = newKey();
    const first = await call({ method: 'POST', url: '/workforce/workers', body, key });
    const second = await call({ method: 'POST', url: '/workforce/workers', body, key });
    expect(first.status).toBe(201);
    expect((second.body as WorkerDto).id).toBe((first.body as WorkerDto).id);
    const changed = await call({
      method: 'POST',
      url: '/workforce/workers',
      body: { ...body, fullName: 'Other' },
      key,
    });
    expect(changed.status).toBe(422);
    const empty = await call({ method: 'POST', url: '/workforce/workers', body, key: '' });
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body and the CNIC rules', async () => {
    const bad = [
      workerBody({ fullName: '' }),
      workerBody({ tradeCode: '' }),
      workerBody({ employmentType: 'casual' }),
      workerBody({ joinedOn: '01/01/2026' }),
      workerBody({ contractorPartyId: 'x' }),
    ];
    for (const body of bad) {
      expect((await call({ method: 'POST', url: '/workforce/workers', body })).status).toBe(400);
    }
    const noCnic = await call({
      method: 'POST',
      url: '/workforce/workers',
      body: workerBody({ cnic: null }),
    });
    expect(errorCode(noCnic)).toBe('cnic_required');
    const taken = workerBody();
    expect((await call({ method: 'POST', url: '/workforce/workers', body: taken })).status).toBe(
      201,
    );
    const again = await call({ method: 'POST', url: '/workforce/workers', body: taken });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('cnic_in_use');
    const contractor = await kit.contractor();
    const brought = await call({
      method: 'POST',
      url: '/workforce/workers',
      body: workerBody({ cnic: null, employmentType: 'contract', contractorPartyId: contractor }),
    });
    expect(brought.status).toBe(201);
  });

  it('gets, lists with filters, masks the CNIC and never carries pay (BR-7, BR-8)', async () => {
    const worker = await createWorker({ fullName: 'Visible Vahid' });
    const full = (await call({ method: 'GET', url: `/workforce/workers/${worker.id}` }))
      .body as WorkerDto;
    expect(full.cnic).toMatch(/^\d{13}$|^\*+\d{4}$/);
    const listed = await call({
      method: 'GET',
      url: '/workforce/workers?text=Visible%20Vahid&status=active&tradeCode=mason&limit=5',
    });
    const page = listed.body as PageResult<WorkerDto>;
    expect(page.total).toBe(1);
    expect(page.items[0]?.cnic).toMatch(/^\*+\d{4}$/);
    for (const item of page.items) {
      expect(Object.keys(item).join(',')).not.toMatch(/rate|amount|salary|wage/i);
    }
    expect((await call({ method: 'GET', url: '/workforce/workers?limit=0' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/workforce/workers?status=gone' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/workforce/workers/not-a-uuid' })).status).toBe(400);
    expect((await call({ method: 'GET', url: `/workforce/workers/${MISSING}` })).status).toBe(404);
  });

  it('updates with the expected version and reports a conflict', async () => {
    const worker = await createWorker();
    const key = newKey();
    const patch = { fullName: 'Renamed Worker', version: worker.version };
    const first = await call({
      method: 'PATCH',
      url: `/workforce/workers/${worker.id}`,
      body: patch,
      key,
    });
    const replay = await call({
      method: 'PATCH',
      url: `/workforce/workers/${worker.id}`,
      body: patch,
      key,
    });
    expect(first.body).toMatchObject({ fullName: 'Renamed Worker', version: 2 });
    expect(replay.body).toEqual(first.body);
    const stale = await call({
      method: 'PATCH',
      url: `/workforce/workers/${worker.id}`,
      body: patch,
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/workforce/workers/${worker.id}`,
          body: { fullName: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ method: 'PATCH', url: `/workforce/workers/${MISSING}`, body: { version: 1 } }))
        .status,
    ).toBe(404);
  });

  it('deactivates with a leaving date, and blocks on unapproved attendance (BR-6)', async () => {
    const worker = await createWorker();
    expect(
      (
        await call({
          method: 'POST',
          url: `/workforce/workers/${worker.id}/deactivate`,
          body: { version: 1 },
        })
      ).status,
    ).toBe(400);
    kit.unapproved.sheets = [{ id: 'sheet-1', date: '2026-02-01' }];
    const blocked = await call({
      method: 'POST',
      url: `/workforce/workers/${worker.id}/deactivate`,
      body: { leftOn: '2026-02-01', version: 1 },
    });
    expect(errorCode(blocked)).toBe('unapproved_attendance');
    kit.unapproved.sheets = [];
    const done = await call({
      method: 'POST',
      url: `/workforce/workers/${worker.id}/deactivate`,
      body: { leftOn: '2026-02-01', version: 1 },
    });
    expect(done.body).toMatchObject({ status: 'inactive', leftOn: '2026-02-01' });
    const again = await call({
      method: 'POST',
      url: `/workforce/workers/${worker.id}/deactivate`,
      body: { leftOn: '2026-02-01', version: 1 },
    });
    expect(again.status).toBe(422);
    expect(errorCode(again)).toBe('worker_inactive');
    expect(
      (
        await call({
          method: 'POST',
          url: `/workforce/workers/${MISSING}/deactivate`,
          body: { leftOn: '2026-02-01', version: 1 },
        })
      ).status,
    ).toBe(404);
  });

  it('removes a worker without history and keeps one that has rates', async () => {
    const plain = await createWorker();
    expect(
      (await call({ method: 'DELETE', url: `/workforce/workers/${plain.id}?version=1` })).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/workforce/workers/${plain.id}?version=1` })).status,
    ).toBe(404);
    const used = await createWorker();
    await call({
      method: 'POST',
      url: `/workforce/workers/${used.id}/rates`,
      body: { payBasis: 'daily_rate', amount: '900', effectiveFrom: '2026-01-01' },
    });
    const kept = await call({ method: 'DELETE', url: `/workforce/workers/${used.id}?version=1` });
    expect(errorCode(kept)).toBe('worker_in_use');
    expect((await call({ method: 'DELETE', url: `/workforce/workers/${used.id}` })).status).toBe(
      400,
    );
  });
});

describe('pay rates', () => {
  it('adds rates that close the open one, lists the history and looks up by date', async () => {
    const worker = await createWorker();
    const url = `/workforce/workers/${worker.id}/rates`;
    const key = newKey();
    const body = { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' };
    const first = await call({ method: 'POST', url, body, key, user: ACCOUNTANT });
    const replay = await call({ method: 'POST', url, body, key, user: ACCOUNTANT });
    expect(first.status).toBe(201);
    expect((replay.body as RateDto).id).toBe((first.body as RateDto).id);
    await call({
      method: 'POST',
      url,
      body: { payBasis: 'daily_rate', amount: '1100', effectiveFrom: '2026-07-01' },
    });
    const history = (await call({ method: 'GET', url, user: ACCOUNTANT })).body as RateDto[];
    expect(history.map((r) => [r.amount, r.effectiveFrom, r.effectiveTo])).toEqual([
      ['1000.00', '2026-01-01', '2026-06-30'],
      ['1100.00', '2026-07-01', null],
    ]);
    const at = async (date: string) =>
      (await call({ method: 'GET', url: `/workforce/workers/${worker.id}/rate?date=${date}` }))
        .body as WorkerRateDto;
    expect((await at('2026-06-30')).amount).toBe('1000.00');
    expect((await at('2026-07-01')).amount).toBe('1100.00');
    const none = await call({
      method: 'GET',
      url: `/workforce/workers/${worker.id}/rate?date=2025-12-31`,
    });
    expect(none.status).toBe(404);
    expect(errorCode(none)).toBe('rate_not_found');
    expect(
      (await call({ method: 'GET', url: `/workforce/workers/${worker.id}/rate?date=bad` })).status,
    ).toBe(400);
  });

  it('converts a monthly salary with the working-days basis and validates the input', async () => {
    const worker = await createWorker({ employmentType: 'permanent' });
    const url = `/workforce/workers/${worker.id}/rates`;
    await call({
      method: 'POST',
      url,
      body: { payBasis: 'monthly_salary', amount: '26000', effectiveFrom: '2026-01-01' },
    });
    const rate = (
      await call({ method: 'GET', url: `/workforce/workers/${worker.id}/rate?date=2026-03-01` })
    ).body as WorkerRateDto;
    expect(rate).toMatchObject({ payBasis: 'monthly_salary', dailyEquivalent: '1000.0000' });
    const bad = [
      { payBasis: 'hourly', amount: '1', effectiveFrom: '2026-01-01' },
      { payBasis: 'daily_rate', amount: '', effectiveFrom: '2026-01-01' },
      { payBasis: 'daily_rate', amount: '1', effectiveFrom: '1/1/2026' },
    ];
    for (const body of bad) expect((await call({ method: 'POST', url, body })).status).toBe(400);
    const zero = await call({
      method: 'POST',
      url,
      body: { payBasis: 'daily_rate', amount: '0', effectiveFrom: '2026-02-01' },
    });
    expect(errorCode(zero)).toBe('rate_amount_invalid');
    expect((await call({ method: 'GET', url: `/workforce/workers/${MISSING}/rates` })).status).toBe(
      404,
    );
    expect(
      (
        await call({
          method: 'POST',
          url: `/workforce/workers/${MISSING}/rates`,
          body: { payBasis: 'daily_rate', amount: '1', effectiveFrom: '2026-01-01' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('teams', () => {
  it('creates, reads, updates and removes a team', async () => {
    const key = newKey();
    const body = { name: 'Route team', supervisorUserId: SUPERVISOR };
    const created = await call({ method: 'POST', url: '/workforce/teams', body, key, user: PM });
    const replay = await call({ method: 'POST', url: '/workforce/teams', body, key, user: PM });
    expect(created.status).toBe(201);
    expect((replay.body as TeamDto).id).toBe((created.body as TeamDto).id);
    const team = created.body as TeamDto;
    const detail = (await call({ method: 'GET', url: `/workforce/teams/${team.id}` }))
      .body as TeamDetailDto;
    expect(detail).toMatchObject({ id: team.id, members: [] });
    const patched = await call({
      method: 'PATCH',
      url: `/workforce/teams/${team.id}`,
      body: { name: 'Renamed team', version: 1 },
    });
    expect(patched.body).toMatchObject({ name: 'Renamed team', version: 2 });
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/workforce/teams/${team.id}`,
          body: { name: 'Stale', version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/workforce/teams/${team.id}?version=2` })).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/workforce/teams/${team.id}?version=2` })).status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: `/workforce/teams/${team.id}` })).status).toBe(404);
  });

  it('validates the team and its supervisor (BR-5)', async () => {
    for (const body of [
      { supervisorUserId: SUPERVISOR },
      { name: 'T' },
      { name: 'T', supervisorUserId: 'x' },
      { name: '', supervisorUserId: SUPERVISOR },
    ]) {
      expect((await call({ method: 'POST', url: '/workforce/teams', body })).status).toBe(400);
    }
    const notSupervisor = await call({
      method: 'POST',
      url: '/workforce/teams',
      body: { name: 'T', supervisorUserId: ACCOUNTANT },
    });
    expect(errorCode(notSupervisor)).toBe('supervisor_invalid');
    expect((await call({ method: 'GET', url: '/workforce/teams/not-a-uuid' })).status).toBe(400);
    expect(
      (await call({ method: 'PATCH', url: `/workforce/teams/${MISSING}`, body: { version: 1 } }))
        .status,
    ).toBe(404);
    expect((await call({ method: 'DELETE', url: `/workforce/teams/${MISSING}` })).status).toBe(400);
  });

  it('moves workers between teams and lets a supervisor see only their own (AC-2)', async () => {
    const mine = await kit.team({ supervisorUserId: SUPERVISOR });
    const theirs = await kit.team({ supervisorUserId: SUPERVISOR2 });
    const a = await createWorker({ fullName: 'Own Member' });
    const b = await createWorker({ fullName: 'Foreign Member' });
    const put = (team: TeamDto, workerIds: string[], version = team.version, date = '2026-10-01') =>
      call({
        method: 'PUT',
        url: `/workforce/teams/${team.id}/members`,
        body: { workerIds, version, date },
      });
    const first = await put(mine, [a.id]);
    expect(first.status).toBe(200);
    expect((first.body as TeamDetailDto).members.map((m) => m.workerId)).toEqual([a.id]);
    expect((await put(theirs, [b.id])).status).toBe(200);
    const stale = await put(mine, [a.id], 1);
    expect(stale.status).toBe(409);
    expect((await put(mine, ['x'])).status).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/workforce/teams/${mine.id}/members`,
          body: { workerIds: [a.id] },
        })
      ).status,
    ).toBe(400);
    const missingTeam = await call({
      method: 'PUT',
      url: `/workforce/teams/${MISSING}/members`,
      body: { workerIds: [], version: 1 },
    });
    expect(missingTeam.status).toBe(404);

    const teamsSeen = (await call({ method: 'GET', url: '/workforce/teams', user: SUPERVISOR }))
      .body as TeamDto[];
    expect(teamsSeen.map((t) => t.id)).toContain(mine.id);
    expect(teamsSeen.map((t) => t.id)).not.toContain(theirs.id);
    const workersSeen = (
      await call({ method: 'GET', url: '/workforce/workers?limit=200', user: SUPERVISOR })
    ).body as PageResult<WorkerDto>;
    const ids = workersSeen.items.map((w) => w.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(
      (await call({ method: 'GET', url: `/workforce/workers/${b.id}`, user: SUPERVISOR })).status,
    ).toBe(404);
    expect(
      (await call({ method: 'GET', url: `/workforce/teams/${theirs.id}`, user: SUPERVISOR }))
        .status,
    ).toBe(404);
    const mineList = (await call({ method: 'GET', url: '/workforce/teams/mine', user: SUPERVISOR }))
      .body as TeamDetailDto[];
    expect(mineList.find((t) => t.id === mine.id)?.members.map((m) => m.workerId)).toEqual([a.id]);
    for (const team of mineList) {
      expect(JSON.stringify(team)).not.toMatch(/amount|salary|rate/i);
    }
  });
});
