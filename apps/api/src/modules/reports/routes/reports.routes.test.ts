import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  PROCUREMENT,
  SUPERVISOR,
  createReportsKit,
  type ReportsKit,
  type ScenarioIds,
} from '../test-support.js';
import type { ReportPageDto, SavedFilterDto } from '../types.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: ReportsKit;
let ids: ScenarioIds;
beforeAll(async () => {
  kit = await createReportsKit();
  ids = await kit.seed();
}, 240_000);
afterAll(() => kit.close());

interface Call {
  method?: 'GET' | 'POST' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
  anonymous?: boolean;
}

const call = async ({ method = 'GET', url, user = MANAGEMENT, body, key, anonymous }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(anonymous === true ? {} : await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return response;
};
const json = async <T>(call$: Promise<{ statusCode: number; json: <U>() => U }>) => {
  const response = await call$;
  return { status: response.statusCode, body: response.json<T>() };
};
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

let keyCounter = 0;
const newKey = () => `reports-key-${++keyCounter}`;

describe('GET /reports/:code (json)', () => {
  it('returns a page with columns, totals over the whole set and the other tables', async () => {
    const { status, body } = await json<ReportPageDto>(
      call({ url: '/reports/project-cost?limit=2&offset=1&sort=used&direction=desc' }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ code: 'project-cost', total: 5, limit: 2, offset: 1 });
    expect(body.items.map((row) => row.used)).toEqual(['12000.00', '1625.00']);
    expect(body.columns.map((c) => c.key)).toContain('percentUsed');
    expect(body.totals).toMatchObject({ used: '65075.00', variance: '94925.00' });
    expect(body.extras.map((section) => section.key)).toEqual(['projects']);
  });

  it('answers every report for a role that may open it', async () => {
    const urls: [string, string][] = [
      ['/reports/stock', MANAGEMENT],
      ['/reports/purchasing?overdueOnly=true', PROCUREMENT],
      ['/reports/labour?from=2026-10-01&to=2026-10-31', ACCOUNTANT],
      ['/reports/dpr-compliance?from=2026-10-19&to=2026-10-23', PM],
      ['/reports/pipeline', PM],
      ['/reports/client-material?projectId=' + ids.projectA, ACCOUNTANT],
    ];
    for (const [url, user] of urls) {
      const { status, body } = await json<ReportPageDto>(call({ url, user }));
      expect(status, url).toBe(200);
      expect(body.items.length, url).toBeGreaterThan(0);
    }
  });

  it('refuses invalid input with a validation error', async () => {
    for (const url of [
      '/reports/project-cost?limit=500',
      '/reports/project-cost?limit=0',
      '/reports/project-cost?offset=-1',
      '/reports/project-cost?projectId=not-a-uuid',
      '/reports/labour?from=yesterday',
      '/reports/stock?ownership=somebody',
      '/reports/stock?belowReorderOnly=maybe',
      '/reports/project-cost?format=pdf',
      '/reports/project-cost?direction=sideways',
    ]) {
      const { status, body } = await json(call({ url }));
      expect(status, url).toBe(400);
      expect(errorCode(body), url).toBe('validation_failed');
    }
    const unknown = await json(call({ url: '/reports/nothing' }));
    expect(unknown.status).toBe(400);
    const sort = await json(call({ url: '/reports/stock?sort=nothing' }));
    expect([sort.status, errorCode(sort.body)]).toEqual([400, 'invalid_sort']);
    const period = await json(call({ url: '/reports/labour?from=2026-10-31&to=2026-10-01' }));
    expect([period.status, errorCode(period.body)]).toEqual([400, 'period_invalid']);
  });

  it('denies a role without the permission and a caller who is not signed in (AC-3)', async () => {
    for (const code of [
      'project-cost',
      'stock',
      'purchasing',
      'labour',
      'dpr-compliance',
      'pipeline',
      'client-material',
    ]) {
      for (const format of ['json', 'csv', 'xlsx']) {
        const { status, body } = await json(
          call({ url: `/reports/${code}?format=${format}`, user: SUPERVISOR }),
        );
        expect([status, errorCode(body)], `${code} ${format}`).toEqual([403, 'forbidden']);
      }
    }
    expect((await json(call({ url: '/reports/stock', user: NOBODY }))).status).toBe(403);
    expect((await json(call({ url: '/reports/labour', user: PM }))).status).toBe(403);
    expect((await json(call({ url: '/reports/stock', anonymous: true }))).status).toBe(401);
  });
});

describe('GET /reports/:code (csv and xlsx)', () => {
  it('downloads CSV with a file name and the header block', async () => {
    const response = await call({ url: '/reports/stock?format=csv&ownership=company' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="stock-2026-10-25.csv"',
    );
    const lines = response.body.replace('﻿', '').split('\r\n');
    expect(lines[0]).toBe('Report,Stock on hand');
    expect(lines[1]).toBe('Filters,Ownership: company');
    expect(lines).toContain('Total,,,,,,,5000.00');
  });

  it('downloads an Excel file that opens with the right numbers (AC-2)', async () => {
    const response = await call({
      url: '/reports/labour?format=xlsx&from=2026-10-01&to=2026-10-31',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toContain('labour-2026-10-25.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    expect(sheet.getRow(1).getCell(2).value).toBe('Labour');
    expect(sheet.getRow(2).getCell(2).value).toBe('From: 2026-10-01; To: 2026-10-31');
    const first = sheet.getRow(8);
    expect([first.getCell(1).value, first.getCell(4).value, first.getCell(5).value]).toEqual([
      ids.projectA_code,
      1.25,
      1625,
    ]);
  });
});

describe('saved filters', () => {
  const body = { reportCode: 'stock', name: 'Cement only', filter: {} };

  it('creates a filter, lists it and removes it', async () => {
    const create = await json<SavedFilterDto>(
      call({
        method: 'POST',
        url: '/reports/saved-filters',
        body: { ...body, filter: { itemId: ids.item1, belowReorderOnly: true } },
      }),
    );
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({
      reportCode: 'stock',
      name: 'Cement only',
      filter: { itemId: ids.item1, belowReorderOnly: true },
      version: 1,
    });
    const list = await json<SavedFilterDto[]>(
      call({ url: '/reports/saved-filters?reportCode=stock' }),
    );
    expect(list.body.map((f) => f.id)).toEqual([create.body.id]);
    const others = await json<SavedFilterDto[]>(
      call({ url: '/reports/saved-filters', user: ACCOUNTANT }),
    );
    expect(others.body).toEqual([]);
    const removed = await json(
      call({ method: 'DELETE', url: `/reports/saved-filters/${create.body.id}?version=1` }),
    );
    expect(removed.status).toBe(200);
    expect((await json<SavedFilterDto[]>(call({ url: '/reports/saved-filters' }))).body).toEqual(
      [],
    );
  });

  it('refuses bad input, a report the caller may not open and a duplicate name', async () => {
    const post = (payload: unknown, user = MANAGEMENT) =>
      json(call({ method: 'POST', url: '/reports/saved-filters', body: payload, user }));
    expect((await post({ ...body, reportCode: 'nothing' })).status).toBe(400);
    expect((await post({ ...body, name: '' })).status).toBe(400);
    expect((await post({ ...body, filter: { projectId: 'x' } })).status).toBe(400);
    expect((await post({ ...body, user: 'x' })).status).toBe(201);
    const denied = await post({ ...body, reportCode: 'labour', name: 'Mine' }, PM);
    expect([denied.status, errorCode(denied.body)]).toEqual([403, 'forbidden']);
    const again = await post({ ...body, user: 'x' });
    expect([again.status, errorCode(again.body)]).toEqual([409, 'saved_filter_exists']);
    expect((await json(call({ url: '/reports/saved-filters?reportCode=nothing' }))).status).toBe(
      400,
    );
  });

  it('replays a retried create with the same Idempotency-Key and refuses a bad key', async () => {
    const key = newKey();
    const payload = { ...body, name: 'Retried', filter: {} };
    const first = await json<SavedFilterDto>(
      call({ method: 'POST', url: '/reports/saved-filters', body: payload, key }),
    );
    const second = await json<SavedFilterDto>(
      call({ method: 'POST', url: '/reports/saved-filters', body: payload, key }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const mine = await json<SavedFilterDto[]>(call({ url: '/reports/saved-filters' }));
    expect(mine.body.filter((f) => f.name === 'Retried')).toHaveLength(1);
    const bad = await kit.app.inject({
      method: 'POST',
      url: '/reports/saved-filters',
      headers: { ...(await kit.auth(MANAGEMENT)), 'idempotency-key': '' },
      payload: { ...payload, name: 'Other' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers not found for a filter that is missing or belongs to someone else, and 409 on a stale version', async () => {
    const created = await json<SavedFilterDto>(
      call({ method: 'POST', url: '/reports/saved-filters', body: { ...body, name: 'Versioned' } }),
    );
    const del = (id: string, version: number, user = MANAGEMENT, key?: string) =>
      json(
        call({
          method: 'DELETE',
          url: `/reports/saved-filters/${id}?version=${version}`,
          user,
          key,
        }),
      );
    const stale = await del(created.body.id, 5);
    expect([stale.status, errorCode(stale.body)]).toEqual([409, 'version_conflict']);
    const foreign = await del(created.body.id, 1, ACCOUNTANT);
    expect([foreign.status, errorCode(foreign.body)]).toEqual([404, 'saved_filter_not_found']);
    const missing = await del('018f0000-0000-7000-8000-000000000999', 1);
    expect(missing.status).toBe(404);
    expect((await del(created.body.id, 0)).status).toBe(400);
    expect(
      (await json(call({ method: 'DELETE', url: '/reports/saved-filters/nope?version=1' }))).status,
    ).toBe(400);
    const key = newKey();
    expect((await del(created.body.id, 1, MANAGEMENT, key)).status).toBe(200);
    // The retry replays the first answer instead of failing on a filter that is gone.
    expect((await del(created.body.id, 1, MANAGEMENT, key)).status).toBe(200);
    expect((await del(created.body.id, 1)).status).toBe(404);
  });
});
