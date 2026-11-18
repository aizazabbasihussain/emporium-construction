import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  createBillingKit,
  uid,
  type BillingKit,
} from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

const MISSING = uid(987654);

async function call(
  userId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await kit.app.inject({
    method,
    url,
    headers: { ...(await kit.auth(userId)), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}
const acc = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => call(ACCOUNTANT, method, url, body, headers);

async function stageIds(projectId: string) {
  return (await kit.schedule(projectId)).stages.map((s) => s.id);
}

describe('permissions (spec section 6)', () => {
  it('refuses a user with no role on every endpoint, and a project manager too', async () => {
    const project = await kit.project();
    const invoice = await kit.draft(project.id, [1]);
    const requests: ['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
      ['GET', `/billing/schedule/${project.id}`],
      ['PUT', `/billing/schedule/${project.id}`, { stages: [] }],
      ['GET', '/billing/invoices'],
      [
        'POST',
        '/billing/invoices',
        { projectId: project.id, scheduleIds: [], invoiceDate: '2026-11-18' },
      ],
      ['GET', `/billing/invoices/${invoice.id}`],
      [
        'PUT',
        `/billing/invoices/${invoice.id}`,
        { scheduleIds: [], invoiceDate: '2026-11-18', version: 1 },
      ],
      ['DELETE', `/billing/invoices/${invoice.id}?version=1`],
      ['GET', `/billing/invoices/${invoice.id}/preview`],
      ['POST', `/billing/invoices/${invoice.id}/submit`, { version: 1 }],
      ['POST', `/billing/invoices/${invoice.id}/issue`, { version: 1 }],
      ['POST', `/billing/invoices/${invoice.id}/cancel-by-credit-note`, { reason: 'x' }],
      ['GET', `/billing/invoices/${invoice.id}/credit-notes`],
      ['POST', `/billing/invoices/${invoice.id}/credit-notes`, { reason: 'x' }],
      ['GET', `/billing/credit-notes/${MISSING}`],
      ['POST', `/billing/credit-notes/${MISSING}/submit`, { version: 1 }],
      ['POST', `/billing/credit-notes/${MISSING}/issue`, { version: 1 }],
      ['GET', `/billing/advances?projectId=${project.id}`],
      [
        'POST',
        '/billing/advances',
        { projectId: project.id, amount: '1', invoiceDate: '2026-11-18' },
      ],
      ['GET', `/billing/invoices/${invoice.id}/print-model`],
      ['GET', `/billing/invoices/${invoice.id}/pdf`],
      ['GET', `/billing/projects/${project.id}/summary`],
    ];
    for (const user of [NOBODY, PM]) {
      for (const [method, url, body] of requests) {
        expect((await call(user, method, url, body)).status, `${user} ${method} ${url}`).toBe(403);
      }
    }
  });

  it('lets management read but not change anything', async () => {
    const project = await kit.project();
    const invoice = await kit.draft(project.id, [1]);
    for (const url of [
      `/billing/schedule/${project.id}`,
      '/billing/invoices',
      `/billing/invoices/${invoice.id}`,
      `/billing/invoices/${invoice.id}/print-model`,
      `/billing/projects/${project.id}/summary`,
    ]) {
      expect((await call(MANAGEMENT, 'GET', url)).status, url).toBe(200);
    }
    for (const [method, url, body] of [
      [
        'POST',
        '/billing/invoices',
        { projectId: project.id, scheduleIds: [], invoiceDate: '2026-11-18' },
      ],
      ['POST', `/billing/invoices/${invoice.id}/issue`, { version: 1 }],
      ['PUT', `/billing/schedule/${project.id}`, { stages: [] }],
      [
        'POST',
        '/billing/advances',
        { projectId: project.id, amount: '1', invoiceDate: '2026-11-18' },
      ],
    ] as const) {
      expect((await call(MANAGEMENT, method, url, body)).status, url).toBe(403);
    }
  });
});

describe('schedule endpoints', () => {
  it('reads the schedule, edits it and refuses invalid bodies and unknown projects', async () => {
    const project = await kit.project({ value: '1000000' });
    const read = await acc('GET', `/billing/schedule/${project.id}`);
    expect(read.status).toBe(200);
    expect(read.body?.stages).toHaveLength(3);
    const edit = await acc('PUT', `/billing/schedule/${project.id}`, {
      stages: [{ stageNo: 1, name: 'All at once', amount: '1000000' }],
    });
    expect(edit.status).toBe(200);
    expect(edit.body?.pendingEditId).not.toBeNull();
    expect(
      (
        await acc('PUT', `/billing/schedule/${project.id}`, {
          stages: [{ stageNo: 0, name: '', amount: 'x' }],
        })
      ).status,
    ).toBe(400);
    expect((await acc('GET', '/billing/schedule/not-a-uuid')).status).toBe(400);
    expect((await acc('GET', `/billing/schedule/${MISSING}`)).status).toBe(404);
  });
});

describe('invoice endpoints', () => {
  it('creates, reads, edits, previews, submits and cancels an invoice with the right status codes', async () => {
    const project = await kit.project();
    const [s1, s2] = await stageIds(project.id);
    const created = await acc('POST', '/billing/invoices', {
      projectId: project.id,
      scheduleIds: [s1],
      invoiceDate: '2026-11-18',
    });
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    expect(created.body).toMatchObject({ status: 'draft', baseAmount: '1500000.00', number: null });

    expect((await acc('GET', `/billing/invoices/${id}`)).status).toBe(200);
    const list = await acc('GET', `/billing/invoices?projectId=${project.id}&status=draft&limit=5`);
    expect(list.body).toMatchObject({ total: 1, limit: 5 });

    const updated = await acc('PUT', `/billing/invoices/${id}`, {
      scheduleIds: [s1, s2],
      invoiceDate: '2026-11-18',
      paymentDays: 10,
      version: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ baseAmount: '3500000.00', version: 2 });
    expect(
      (
        await acc('PUT', `/billing/invoices/${id}`, {
          scheduleIds: [s1],
          invoiceDate: '2026-11-18',
          version: 1,
        })
      ).status,
    ).toBe(409);

    const preview = await acc('GET', `/billing/invoices/${id}/preview`);
    expect(preview.body).toMatchObject({
      taxTotal: '350000.00',
      grossTotal: '3850000.00',
      authorityCode: 'FBR',
    });

    expect((await acc('POST', `/billing/invoices/${id}/submit`, { version: 1 })).status).toBe(409);
    const submitted = await acc('POST', `/billing/invoices/${id}/submit`, { version: 2 });
    expect(submitted.status).toBe(200);
    expect(submitted.body?.status).toBe('pending_approval');

    const cancelled = await acc('DELETE', `/billing/invoices/${id}?version=3`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body?.status).toBe('cancelled');
  });

  it('issues an approved invoice and refuses a second issue', async () => {
    const project = await kit.project();
    const approved = await kit.approved(project.id, [1]);
    const issued = await acc('POST', `/billing/invoices/${approved.id}/issue`, {
      version: approved.version,
    });
    expect(issued.status).toBe(200);
    expect(issued.body?.number).toMatch(/^INV-2026-\d{4}$/);
    expect(
      (
        await acc('POST', `/billing/invoices/${approved.id}/issue`, {
          version: issued.body?.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await acc(
          'DELETE',
          `/billing/invoices/${approved.id}?version=${String(issued.body?.version)}`,
        )
      ).status,
    ).toBe(422);
  });

  it('refuses bad input, unknown ids and a stale version', async () => {
    const project = await kit.project();
    expect(
      (
        await acc('POST', '/billing/invoices', {
          projectId: project.id,
          scheduleIds: ['x'],
          invoiceDate: 'today',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await acc('POST', '/billing/invoices', {
          projectId: MISSING,
          scheduleIds: [],
          invoiceDate: '2026-11-18',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await acc('POST', '/billing/invoices', {
          projectId: project.id,
          scheduleIds: [],
          invoiceDate: '2026-11-18',
        })
      ).status,
    ).toBe(400);
    for (const [method, url, body] of [
      ['GET', `/billing/invoices/${MISSING}`],
      [
        'PUT',
        `/billing/invoices/${MISSING}`,
        { scheduleIds: [], invoiceDate: '2026-11-18', version: 1 },
      ],
      ['DELETE', `/billing/invoices/${MISSING}?version=1`],
      ['GET', `/billing/invoices/${MISSING}/preview`],
      ['POST', `/billing/invoices/${MISSING}/submit`, { version: 1 }],
      ['POST', `/billing/invoices/${MISSING}/issue`, { version: 1 }],
      ['POST', `/billing/invoices/${MISSING}/cancel-by-credit-note`, { reason: 'x' }],
      ['GET', `/billing/invoices/${MISSING}/credit-notes`],
      ['POST', `/billing/invoices/${MISSING}/credit-notes`, { reason: 'x' }],
      ['GET', `/billing/invoices/${MISSING}/print-model`],
      ['GET', `/billing/invoices/${MISSING}/pdf`],
      ['GET', `/billing/projects/${MISSING}/summary`],
    ] as const) {
      expect((await acc(method, url, body)).status, `${method} ${url}`).toBe(404);
    }
    const draft = await kit.draft(project.id, [1]);
    expect((await acc('POST', `/billing/invoices/${draft.id}/submit`, {})).status).toBe(400);
    expect((await acc('DELETE', `/billing/invoices/${draft.id}`)).status).toBe(400);
    expect((await acc('GET', '/billing/invoices?status=nope')).status).toBe(400);
  });

  it('replays a create with the same idempotency key and rejects a repeated key with other content', async () => {
    const project = await kit.project();
    const [s1, s2] = await stageIds(project.id);
    const headers = { 'idempotency-key': `bill-${project.id}` };
    const body = { projectId: project.id, scheduleIds: [s1], invoiceDate: '2026-11-18' };
    const first = await acc('POST', '/billing/invoices', body, headers);
    const second = await acc('POST', '/billing/invoices', body, headers);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body?.id).toBe(first.body?.id);
    expect(await kit.billing.listInvoicesForProject(kit.db, project.id)).toHaveLength(1);
    const other = await acc('POST', '/billing/invoices', { ...body, scheduleIds: [s2] }, headers);
    expect(other.status).toBe(422);
    expect((await acc('POST', '/billing/invoices', body, { 'idempotency-key': '' })).status).toBe(
      400,
    );
  });

  it('returns the print model and a PDF without internal data', async () => {
    const project = await kit.project({ where: 'lahore' });
    const invoice = await kit.issued(project.id, [1], { notes: 'INTERNAL' });
    const model = await acc('GET', `/billing/invoices/${invoice.id}/print-model`);
    expect(model.body).toMatchObject({
      registration: { authority: 'PRA', number: 'TEST-PRA-0001' },
      grossTotal: '1740000.00',
    });
    const pdf = await kit.app.inject({
      method: 'GET',
      url: `/billing/invoices/${invoice.id}/pdf`,
      headers: await kit.auth(ACCOUNTANT),
    });
    expect(pdf.statusCode).toBe(200);
    expect(String(pdf.headers['content-type'])).toContain('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toContain(`${invoice.number}.pdf`);
    expect(pdf.body.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.body).toContain('Tax invoice INV-2026');
    expect(pdf.body).not.toContain('INTERNAL');
    const draft = await kit.draft((await kit.project()).id, [1]);
    const draftPdf = await kit.app.inject({
      method: 'GET',
      url: `/billing/invoices/${draft.id}/pdf`,
      headers: await kit.auth(ACCOUNTANT),
    });
    expect(String(draftPdf.headers['content-disposition'])).toContain('draft-');
  });
});

describe('advance and credit note endpoints', () => {
  it('requests an advance, lists it and shows the project summary', async () => {
    const project = await kit.project();
    const created = await acc('POST', '/billing/advances', {
      projectId: project.id,
      amount: '250000',
      invoiceDate: '2026-11-18',
    });
    expect(created.status).toBe(201);
    expect(created.body?.advance).toMatchObject({ status: 'requested', amount: '250000.00' });
    expect(created.body?.invoice).toMatchObject({ sourceType: 'advance' });
    expect((await acc('GET', `/billing/advances?projectId=${project.id}`)).body).toHaveLength(1);
    const summary = await acc('GET', `/billing/projects/${project.id}/summary`);
    expect(summary.body).toMatchObject({
      contractValue: '5000000.00',
      netBilled: '0.00',
      invoices: 1,
    });
    expect(
      (
        await acc('POST', '/billing/advances', {
          projectId: project.id,
          amount: '0',
          invoiceDate: '2026-11-18',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await acc('POST', '/billing/advances', {
          projectId: project.id,
          amount: 'abc',
          invoiceDate: '2026-11-18',
        })
      ).status,
    ).toBe(400);
    expect((await acc('GET', '/billing/advances')).status).toBe(400);
  });

  it('cancels an issued invoice through a credit note, step by step, and lists it', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const partial = await acc('POST', `/billing/invoices/${invoice.id}/credit-notes`, {
      reason: 'Discount',
      baseAmount: '100000',
    });
    expect(partial.status).toBe(201);
    const id = partial.body?.id as string;
    expect((await acc('GET', `/billing/credit-notes/${id}`)).body).toMatchObject({
      status: 'draft',
      grossTotal: '110000.00',
    });
    expect((await acc('POST', `/billing/credit-notes/${id}/submit`, { version: 9 })).status).toBe(
      409,
    );
    expect((await acc('POST', `/billing/credit-notes/${id}/submit`, { version: 1 })).status).toBe(
      200,
    );
    expect((await acc('POST', `/billing/credit-notes/${id}/issue`, { version: 1 })).status).toBe(
      422,
    );
    await kit.decide('credit_note', id, 'approve');
    const issued = await acc('POST', `/billing/credit-notes/${id}/issue`, { version: 1 });
    expect(issued.status).toBe(200);
    expect(issued.body?.number).toMatch(/^CN-2026-\d{4}$/);
    expect((await acc('GET', `/billing/invoices/${invoice.id}/credit-notes`)).body).toHaveLength(1);

    const full = await acc('POST', `/billing/invoices/${invoice.id}/cancel-by-credit-note`, {
      reason: 'Rest',
    });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({ baseAmount: '1400000.00', status: 'draft' });
    expect(
      (await acc('POST', `/billing/invoices/${invoice.id}/credit-notes`, { reason: '' })).status,
    ).toBe(400);
    expect(
      (
        await acc('POST', `/billing/invoices/${invoice.id}/credit-notes`, {
          reason: 'x',
          baseAmount: '-1',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await acc('POST', `/billing/invoices/${invoice.id}/credit-notes`, {
          reason: 'too much',
          baseAmount: '9999999',
        })
      ).status,
    ).toBe(422);
  });
});
