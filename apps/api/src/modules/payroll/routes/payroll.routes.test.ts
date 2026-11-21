/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the tests read parsed JSON answers */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  TODAY,
  createPayrollKit,
  type PayrollKit,
} from '../test-support.js';

let kit: PayrollKit;
let periodId: string;
let account: string;
beforeAll(async () => {
  kit = await createPayrollKit();
  periodId = (await kit.month({ allowance: '500' })).periodId;
  account = await kit.bank();
}, 180_000);
afterAll(() => kit.close());

type Body = any;

async function call(
  user: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await kit.app.inject({
    method,
    url,
    headers: { ...(user === null ? {} : await kit.auth(user)), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const type = String(response.headers['content-type'] ?? '');
  return {
    status: response.statusCode,
    body: type.includes('json') ? response.json() : response.rawPayload,
    type,
  };
}

describe('payroll routes: from an approved wage sheet to a paid run', () => {
  let runId: string;
  let version: number;
  let paymentId: string;
  let paymentVersion: number;

  it('creates a run, lists it and reads its lines', async () => {
    const created = await call(ACCOUNTANT, 'POST', '/payroll/runs', { periodId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', lineCount: 2 });
    runId = created.body.id;
    version = created.body.version;
    expect((await call(MANAGEMENT, 'GET', '/payroll/runs')).body.total).toBe(1);
    expect((await call(MANAGEMENT, 'GET', `/payroll/runs/${runId}`)).body.id).toBe(runId);
    const lines = await call(MANAGEMENT, 'GET', `/payroll/runs/${runId}/lines`);
    expect(lines.body).toHaveLength(2);
    expect(lines.body[0]).toMatchObject({ paymentStatus: 'unpaid' });
    expect((await call(ACCOUNTANT, 'POST', '/payroll/runs', { periodId })).status).toBe(409);
    expect((await call(ACCOUNTANT, 'POST', '/payroll/runs', { periodId: 'x' })).status).toBe(400);
  });

  it('keeps payslips back until the run is finalized', async () => {
    expect((await call(ACCOUNTANT, 'GET', `/payroll/runs/${runId}/payslips.pdf`)).status).toBe(422);
  });

  it('finalizes once, replaying the first answer for the same idempotency key', async () => {
    const first = await call(
      ACCOUNTANT,
      'POST',
      `/payroll/runs/${runId}/finalize`,
      { version },
      { 'idempotency-key': 'finalize-1' },
    );
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('finalized');
    const again = await call(
      ACCOUNTANT,
      'POST',
      `/payroll/runs/${runId}/finalize`,
      { version },
      { 'idempotency-key': 'finalize-1' },
    );
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(first.body.version);
    version = first.body.version;
    const bad = await call(
      ACCOUNTANT,
      'POST',
      `/payroll/runs/${runId}/finalize`,
      { version },
      { 'idempotency-key': '' },
    );
    expect(bad.status).toBe(400);
  });

  it('produces the payslips, as one PDF set and one by one', async () => {
    const pdf = await call(ACCOUNTANT, 'GET', `/payroll/runs/${runId}/payslips.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
    const lines = (await call(MANAGEMENT, 'GET', `/payroll/runs/${runId}/lines`)).body;
    const slip = await call(MANAGEMENT, 'GET', `/payroll/payslips/${lines[0].id}`);
    expect(slip.status).toBe(200);
    expect(slip.body.number).toMatch(/^PSL-/);
    expect(slip.body.rate).toBeNull();
  });

  it('pays through the cash book and reads the payments and the unpaid report', async () => {
    const request = await call(ACCOUNTANT, 'POST', `/payroll/runs/${runId}/payment-requests`, {});
    expect(request.status).toBe(201);
    await kit.approvePayment(request.body.approvalDocId);
    const body = {
      paymentDate: TODAY,
      method: 'cash',
      accountId: account,
      approvalDocId: request.body.approvalDocId,
      version,
    };
    const unpaid = await call(MANAGEMENT, 'GET', '/payroll/unpaid');
    expect(unpaid.body.rows).toHaveLength(2);
    const paid = await call(ACCOUNTANT, 'POST', `/payroll/runs/${runId}/pay`, body);
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('paid');
    paymentId = paid.body.id;
    paymentVersion = paid.body.version;
    expect((await call(MANAGEMENT, 'GET', '/payroll/unpaid')).body.rows).toEqual([]);
    const list = await call(MANAGEMENT, 'GET', `/payroll/runs/${runId}/payments`);
    expect(list.body.map((p: Body) => p.id)).toEqual([paymentId]);
    expect((await call(ACCOUNTANT, 'POST', `/payroll/runs/${runId}/pay`, body)).status).toBe(409);
    expect((await call(ACCOUNTANT, 'POST', `/payroll/runs/${runId}/pay`, {})).status).toBe(400);
  });

  it('lets management, not the accountant, reverse a payment', async () => {
    const url = `/payroll/payments/${paymentId}/reverse`;
    const body = { reason: 'Wrong account', version: paymentVersion };
    expect((await call(ACCOUNTANT, 'POST', url, body)).status).toBe(403);
    const done = await call(MANAGEMENT, 'POST', url, body);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('reversed');
    const run = await call(MANAGEMENT, 'GET', `/payroll/runs/${runId}`);
    expect(run.body.status).toBe('finalized');
    version = run.body.version;
  });

  it('lets management, not the accountant, reopen an unpaid run', async () => {
    const url = `/payroll/runs/${runId}/reopen`;
    const body = { reason: 'Correct the sheet', version };
    expect((await call(ACCOUNTANT, 'POST', url, body)).status).toBe(403);
    const done = await call(MANAGEMENT, 'POST', url, body);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('draft');
  });
});

describe('payroll route permissions (spec section 6)', () => {
  const routes: [string, 'GET' | 'POST', string][] = [
    ['payroll.run.read', 'GET', '/payroll/runs'],
    ['payroll.run.read', 'GET', '/payroll/unpaid'],
    ['payroll.run.create', 'POST', '/payroll/runs'],
    ['payroll.run.finalize', 'POST', '/payroll/runs/018f7c7c-0000-7000-8000-000000000009/finalize'],
    ['payroll.run.reopen', 'POST', '/payroll/runs/018f7c7c-0000-7000-8000-000000000009/reopen'],
    ['payroll.payment.create', 'POST', '/payroll/runs/018f7c7c-0000-7000-8000-000000000009/pay'],
    [
      'payroll.payment.reverse',
      'POST',
      '/payroll/payments/018f7c7c-0000-7000-8000-000000000009/reverse',
    ],
    ['payroll.payslip.read', 'GET', '/payroll/payslips/018f7c7c-0000-7000-8000-000000000009'],
  ];

  it.each(routes)('%s: no token is 401, no permission is 403', async (_permission, method, url) => {
    expect((await call(null, method, url, method === 'POST' ? {} : undefined)).status).toBe(401);
    for (const user of [NOBODY, PM]) {
      expect((await call(user, method, url, method === 'POST' ? {} : undefined)).status).toBe(403);
    }
  });

  it('answers 404 for an unknown run or payslip', async () => {
    const id = '018f7c7c-0000-7000-8000-000000000009';
    expect((await call(MANAGEMENT, 'GET', `/payroll/runs/${id}`)).status).toBe(404);
    expect((await call(MANAGEMENT, 'GET', `/payroll/payslips/${id}`)).status).toBe(404);
    expect((await call(MANAGEMENT, 'GET', `/payroll/runs/${id}/payments`)).status).toBe(404);
  });
});
