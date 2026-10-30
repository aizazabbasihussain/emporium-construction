import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  FRIDAY,
  MANAGEMENT,
  NOBODY,
  SUPERVISOR,
  createWagesKit,
  type WagesKit,
} from '../test-support.js';
import type {
  AdvanceDto,
  LinesDto,
  PageResult,
  PeriodDetailDto,
  PeriodDto,
  ReconciliationDto,
} from '../types.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: WagesKit;
beforeAll(async () => {
  kit = await createWagesKit();
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = ACCOUNTANT, body, key }: Call) => {
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
const newKey = () => `wag-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

describe('authentication and permissions', () => {
  it('refuses anonymous callers, supervisors and callers without the permission', async () => {
    expect((await kit.app.inject({ method: 'GET', url: '/wages/periods' })).statusCode).toBe(401);
    const probes: Omit<Call, 'user'>[] = [
      { method: 'GET', url: '/wages/periods' },
      { method: 'POST', url: '/wages/periods', body: { year: 2040, month: 1 } },
      { method: 'GET', url: `/wages/periods/${MISSING}` },
      { method: 'GET', url: `/wages/periods/${MISSING}/lines` },
      { method: 'GET', url: `/wages/periods/${MISSING}/reconciliation` },
      { method: 'POST', url: `/wages/periods/${MISSING}/calculate` },
      { method: 'POST', url: `/wages/periods/${MISSING}/submit`, body: { version: 1 } },
      {
        method: 'POST',
        url: `/wages/periods/${MISSING}/reopen`,
        body: { reason: 'x', version: 1 },
      },
      {
        method: 'POST',
        url: `/wages/lines/${MISSING}/adjustments`,
        body: { kind: 'allowance', amount: '1', reason: 'x' },
      },
      { method: 'GET', url: '/wages/advances' },
      {
        method: 'POST',
        url: '/wages/advances',
        body: {
          workerId: MISSING,
          amount: '100',
          issuedOn: '2026-09-01',
          monthlyRecovery: '50',
        },
      },
    ];
    for (const user of [NOBODY, SUPERVISOR]) {
      for (const probe of probes) {
        expect(
          (await call({ ...probe, user })).status,
          `${user} ${probe.method} ${probe.url}`,
        ).toBe(403);
      }
    }
  });

  it('keeps each action with its role: owner reopens, accountant adjusts and issues advances', async () => {
    const forbidden = [
      {
        method: 'POST',
        url: `/wages/periods/${MISSING}/reopen`,
        body: { reason: 'x', version: 1 },
      },
      { method: 'POST', url: '/wages/advances', body: {} },
      { method: 'POST', url: `/wages/lines/${MISSING}/adjustments`, body: {} },
    ] as const;
    expect((await call({ ...forbidden[0], user: ACCOUNTANT })).status).toBe(403);
    expect((await call({ ...forbidden[1], user: MANAGEMENT })).status).toBe(403);
    expect((await call({ ...forbidden[2], user: MANAGEMENT })).status).toBe(403);
  });
});

describe('periods over HTTP', () => {
  it('creates a period once per month, with idempotent retry and validation', async () => {
    const key = newKey();
    const created = await call({
      method: 'POST',
      url: '/wages/periods',
      body: { year: 2040, month: 5 },
      key,
    });
    expect(created.status).toBe(201);
    const period = created.body as PeriodDto;
    expect(period).toMatchObject({ year: 2040, month: 5, status: 'draft', from: '2040-05-01' });
    // The same key replays the first response instead of creating a second period.
    const replay = await call({
      method: 'POST',
      url: '/wages/periods',
      body: { year: 2040, month: 5 },
      key,
    });
    expect(replay.status).toBe(201);
    expect((replay.body as PeriodDto).id).toBe(period.id);
    // A new request for the same month conflicts.
    const duplicate = await call({
      method: 'POST',
      url: '/wages/periods',
      body: { year: 2040, month: 5 },
    });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe('period_exists');
    // Bad input.
    expect(
      errorCode(
        await call({ method: 'POST', url: '/wages/periods', body: { year: 2040, month: 13 } }),
      ),
    ).toBe('period_month_invalid');
    expect(
      (await call({ method: 'POST', url: '/wages/periods', body: { year: 'x' } })).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/wages/periods',
          body: { year: 2040, month: 6 },
          key: '',
        })
      ).status,
    ).toBe(400);

    const list = await call({ method: 'GET', url: '/wages/periods?year=2040&limit=5' });
    expect(list.status).toBe(200);
    expect((list.body as PageResult<PeriodDto>).items.map((p) => p.id)).toContain(period.id);
    expect((await call({ method: 'GET', url: '/wages/periods?status=bogus' })).status).toBe(400);
    const owner = await call({
      method: 'GET',
      url: `/wages/periods/${period.id}`,
      user: MANAGEMENT,
    });
    expect(owner.status).toBe(200);
    expect((owner.body as PeriodDetailDto).lineCount).toBe(0);
  });

  it('reports an unknown period or line as not found', async () => {
    for (const url of [
      `/wages/periods/${MISSING}`,
      `/wages/periods/${MISSING}/lines`,
      `/wages/periods/${MISSING}/reconciliation`,
    ]) {
      const r = await call({ method: 'GET', url });
      expect(r.status, url).toBe(404);
    }
    const calculate = await call({ method: 'POST', url: `/wages/periods/${MISSING}/calculate` });
    expect(calculate.status).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: `/wages/lines/${MISSING}/adjustments`,
          body: { kind: 'allowance', amount: '5', reason: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: '/wages/periods/not-a-uuid' })).status).toBe(400);
  });

  it('runs a month from calculation to reopening (AC-2, AC-3)', async () => {
    const setup = await kit.setup();
    await kit.approved(setup, FRIDAY);
    const created = await call({
      method: 'POST',
      url: '/wages/periods',
      body: { year: 2026, month: 10 },
    });
    const period = created.body as PeriodDto;

    const calculated = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/calculate`,
      key: newKey(),
    });
    expect(calculated.status).toBe(200);
    const sheet = calculated.body as LinesDto;
    expect(sheet.period.status).toBe('calculated');
    expect(sheet.lines).toHaveLength(2);
    expect(sheet.totals).toMatchObject({ grossPay: '2000.00', netPay: '2000.00' });
    expect((await call({ method: 'GET', url: `/wages/periods/${period.id}/lines` })).body).toEqual(
      sheet,
    );

    const adjusted = await call({
      method: 'POST',
      url: `/wages/lines/${sheet.lines[0]!.id}/adjustments`,
      body: { kind: 'deduction', amount: '100', reason: 'Fine' },
      key: newKey(),
    });
    expect(adjusted.status).toBe(201);
    expect((adjusted.body as LinesDto).totals.netPay).toBe('1900.00');
    expect(
      errorCode(
        await call({
          method: 'POST',
          url: `/wages/lines/${sheet.lines[0]!.id}/adjustments`,
          body: { kind: 'deduction', amount: '0', reason: 'Fine' },
        }),
      ),
    ).toBe('adjustment_amount_invalid');
    expect(
      (
        await call({
          method: 'POST',
          url: `/wages/lines/${sheet.lines[0]!.id}/adjustments`,
          body: { kind: 'bonus', amount: '5', reason: 'x' },
        })
      ).status,
    ).toBe(400);

    const recon = await call({
      method: 'GET',
      url: `/wages/periods/${period.id}/reconciliation`,
      user: MANAGEMENT,
    });
    expect(recon.status).toBe(200);
    expect((recon.body as ReconciliationDto).totals.difference).toBe('0.00');

    const detail = (await call({ method: 'GET', url: `/wages/periods/${period.id}` }))
      .body as PeriodDetailDto;
    const stale = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/submit`,
      body: { version: detail.version + 3, acknowledgeWarnings: true },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    const unacknowledged = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/submit`,
      body: { version: detail.version },
    });
    expect(errorCode(unacknowledged)).toBe('warnings_not_acknowledged');
    const key = newKey();
    const submitted = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/submit`,
      body: { version: detail.version, acknowledgeWarnings: true },
      key,
    });
    expect(submitted.status).toBe(200);
    expect((submitted.body as PeriodDetailDto).status).toBe('submitted');
    // A retry with the same key replays the answer instead of failing on the new state.
    const replay = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/submit`,
      body: { version: detail.version, acknowledgeWarnings: true },
      key,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as PeriodDetailDto).status).toBe('submitted');

    await kit.wagesDecide(period.id);
    const approved = (await call({ method: 'GET', url: `/wages/periods/${period.id}` }))
      .body as PeriodDetailDto;
    expect(approved.status).toBe('approved');

    const reopened = await call({
      method: 'POST',
      url: `/wages/periods/${period.id}/reopen`,
      user: MANAGEMENT,
      body: { reason: 'Add the missing allowance', version: approved.version },
    });
    expect(reopened.status).toBe(200);
    expect((reopened.body as PeriodDetailDto).status).toBe('reopened');
    expect(
      errorCode(
        await call({
          method: 'POST',
          url: `/wages/periods/${period.id}/reopen`,
          user: MANAGEMENT,
          body: { reason: 'Again', version: (reopened.body as PeriodDetailDto).version },
        }),
      ),
    ).toBe('period_transition');
  });
});

describe('advances over HTTP', () => {
  it('issues and lists advances', async () => {
    const worker = await kit.worker();
    const body = {
      workerId: worker.id,
      amount: '5000',
      issuedOn: '2026-09-01',
      monthlyRecovery: '1000',
      note: 'Rent',
    };
    const created = await call({ method: 'POST', url: '/wages/advances', body, key: newKey() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ workerId: worker.id, balance: '5000.00', status: 'open' });

    const list = await call({
      method: 'GET',
      url: `/wages/advances?worker=${worker.id}&status=open`,
      user: MANAGEMENT,
    });
    expect(list.status).toBe(200);
    const page = list.body as PageResult<AdvanceDto>;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ workerName: worker.fullName });
    expect((await call({ method: 'GET', url: '/wages/advances?status=bogus' })).status).toBe(400);

    expect(
      errorCode(
        await call({ method: 'POST', url: '/wages/advances', body: { ...body, amount: '0' } }),
      ),
    ).toBe('advance_amount_invalid');
    expect(
      errorCode(
        await call({
          method: 'POST',
          url: '/wages/advances',
          body: { ...body, workerId: MISSING },
        }),
      ),
    ).toBe('worker_not_found');
    expect(
      (await call({ method: 'POST', url: '/wages/advances', body: { ...body, issuedOn: 'x' } }))
        .status,
    ).toBe(400);
  });
});
