import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  PM2,
  SUPERVISOR,
  createProfitabilityKit,
  scriptedProject,
  uid,
  type FakeProject,
  type ProfitabilityKit,
} from '../test-support.js';
import type {
  AlertDto,
  ForecastDto,
  PortfolioDto,
  ProjectFinancialsDto,
  ThresholdDto,
} from '../types.js';

let kit: ProfitabilityKit;
let project: FakeProject;
beforeAll(async () => {
  kit = await createProfitabilityKit();
  project = scriptedProject(kit);
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  user?: string;
  body?: unknown;
  key?: string;
  anonymous?: boolean;
}

const call = async ({ method = 'GET', url, user = MANAGEMENT, body, key, anonymous }: Call) =>
  kit.app.inject({
    method,
    url,
    headers: {
      ...(anonymous === true ? {} : await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const json = async <T>(request: Promise<Awaited<ReturnType<typeof call>>>) => {
  const response = await request;
  return { status: response.statusCode, body: response.json<T>() };
};
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

let keys = 0;
const newKey = () => `profitability-key-${++keys}`;

describe('GET /profitability/projects', () => {
  it('returns the portfolio of the caller, as of a date', async () => {
    const { status, body } = await json<PortfolioDto>(call({ url: '/profitability/projects' }));
    expect(status).toBe(200);
    expect(body.asOf).toBe('2026-10-25');
    expect(body.items.find((item) => item.projectId === project.id)).toMatchObject({
      contractValue: '1100000.00',
      cashPosition: '210000.00',
    });
    const earlier = await json<PortfolioDto>(
      call({ url: '/profitability/projects?asOf=2026-10-07&status=active' }),
    );
    expect(earlier.body.asOf).toBe('2026-10-07');
    expect(earlier.body.items.find((item) => item.projectId === project.id)?.contractValue).toBe(
      '1000000.00',
    );
  });

  it('shows a project manager only the projects they manage', async () => {
    const other = kit.project({ projectManagerId: PM2 });
    const mine = await json<PortfolioDto>(call({ url: '/profitability/projects', user: PM }));
    expect(mine.body.items.some((item) => item.projectId === project.id)).toBe(true);
    expect(mine.body.items.some((item) => item.projectId === other.id)).toBe(false);
  });

  it('downloads CSV and Excel with the report header block (BR-9)', async () => {
    const csv = await call({ url: '/profitability/projects?format=csv' });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('profitability-portfolio-2026-10-25.csv');
    expect(csv.body).toContain('Project profitability - all projects');
    expect(csv.body).toContain(project.code);
    const xlsx = await call({ url: '/profitability/projects?format=xlsx' });
    expect(xlsx.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(workbook.worksheets[0]?.name).toBe('Project profitability - all pro');
  });

  it('refuses invalid input, and denies roles without the permission', async () => {
    for (const url of [
      '/profitability/projects?asOf=yesterday',
      '/profitability/projects?asOf=2026-1-1',
      '/profitability/projects?format=pdf',
    ]) {
      const { status, body } = await json(call({ url }));
      expect([status, errorCode(body)], url).toEqual([400, 'validation_failed']);
    }
    const impossible = await json(call({ url: '/profitability/projects?asOf=2026-02-30' }));
    expect([impossible.status, errorCode(impossible.body)]).toEqual([400, 'invalid_date']);
    for (const user of [SUPERVISOR, NOBODY]) {
      for (const format of ['json', 'csv', 'xlsx']) {
        const { status, body } = await json(
          call({ url: `/profitability/projects?format=${format}`, user }),
        );
        expect([status, errorCode(body)]).toEqual([403, 'permission_denied']);
      }
    }
    expect((await json(call({ url: '/profitability/projects', anonymous: true }))).status).toBe(
      401,
    );
  });
});

describe('GET /profitability/projects/:id', () => {
  it('returns every figure of the project (AC-1)', async () => {
    const { status, body } = await json<ProjectFinancialsDto>(
      call({ url: `/profitability/projects/${project.id}` }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      projectId: project.id,
      expectedMargin: '200000.00',
      expectedMarginPercent: '18.18',
      currentMargin: '300000.00',
      cashPosition: '210000.00',
      outstandingReceivable: '354000.00',
    });
    const asOf = await json<ProjectFinancialsDto>(
      call({ url: `/profitability/projects/${project.id}?asOf=2026-10-09`, user: ACCOUNTANT }),
    );
    expect(asOf.body).toMatchObject({ asOf: '2026-10-09', cashPosition: '204000.00' });
  });

  it('downloads the project as CSV and Excel', async () => {
    const csv = await call({ url: `/profitability/projects/${project.id}?format=csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-disposition']).toContain(`profitability-${project.code}-`);
    expect(csv.body).toContain('Expected margin,200000.00,18.18');
    const xlsx = await call({ url: `/profitability/projects/${project.id}?format=xlsx` });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  it('refuses bad input, answers not found for a missing or hidden project, and denies', async () => {
    const bad = await json(call({ url: '/profitability/projects/not-a-uuid' }));
    expect([bad.status, errorCode(bad.body)]).toEqual([400, 'validation_failed']);
    const badDate = await json(call({ url: `/profitability/projects/${project.id}?asOf=soon` }));
    expect(badDate.status).toBe(400);
    const missing = await json(call({ url: `/profitability/projects/${uid(77)}` }));
    expect([missing.status, errorCode(missing.body)]).toEqual([404, 'project_not_found']);
    const hidden = await json(call({ url: `/profitability/projects/${project.id}`, user: PM2 }));
    expect([hidden.status, errorCode(hidden.body)]).toEqual([404, 'project_not_found']);
    const mine = await json(call({ url: `/profitability/projects/${project.id}`, user: PM }));
    expect(mine.status).toBe(200);
    for (const user of [SUPERVISOR, NOBODY]) {
      const denied = await json(call({ url: `/profitability/projects/${project.id}`, user }));
      expect([denied.status, errorCode(denied.body)]).toEqual([403, 'permission_denied']);
    }
    expect(
      (await json(call({ url: `/profitability/projects/${project.id}`, anonymous: true }))).status,
    ).toBe(401);
  });
});

describe('PUT /profitability/projects/:id/forecast', () => {
  it('saves a forecast, which the project then uses; a retry with the same key saves one', async () => {
    const key = newKey();
    const url = `/profitability/projects/${project.id}/forecast`;
    const body = {
      costToComplete: '50000',
      note: 'Revised after the roof',
      forecastDate: '2026-10-24',
    };
    const first = await json<ForecastDto>(call({ method: 'PUT', url, body, key, user: PM }));
    const second = await json<ForecastDto>(call({ method: 'PUT', url, body, key, user: PM }));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ costToComplete: '50000.00', setBy: PM });
    const rows = await kit.db.query<{ n: string }>(
      'select count(*)::text as n from pft_forecasts where id = $1',
      [first.body.id],
    );
    expect(rows[0]?.n).toBe('1');
    const figures = await json<ProjectFinancialsDto>(
      call({ url: `/profitability/projects/${project.id}` }),
    );
    expect(figures.body).toMatchObject({
      costToCompleteSource: 'forecast',
      costToComplete: '50000.00',
    });
    // A different request with the same key is refused rather than replayed.
    const clash = await json(
      call({ method: 'PUT', url, body: { costToComplete: '1' }, key, user: PM }),
    );
    expect(clash.status).toBeGreaterThanOrEqual(400);
    // Reset for the tests that follow: forecast back to the unused budget is not possible, so
    // later tests read the margin as of an earlier date instead.
  });

  it('refuses bad input, denies other roles, and answers not found', async () => {
    const url = `/profitability/projects/${project.id}/forecast`;
    for (const body of [
      {},
      { costToComplete: '' },
      { costToComplete: 5 },
      { costToComplete: '1', forecastDate: 'x' },
    ]) {
      const { status, body: out } = await json(call({ method: 'PUT', url, body }));
      expect([status, errorCode(out)]).toEqual([400, 'validation_failed']);
    }
    const negative = await json(call({ method: 'PUT', url, body: { costToComplete: '-5' } }));
    expect([negative.status, errorCode(negative.body)]).toEqual([400, 'invalid_amount']);
    for (const user of [ACCOUNTANT, SUPERVISOR, NOBODY]) {
      const denied = await json(call({ method: 'PUT', url, body: { costToComplete: '1' }, user }));
      expect([denied.status, errorCode(denied.body)]).toEqual([403, 'permission_denied']);
    }
    const missing = await json(
      call({
        method: 'PUT',
        url: `/profitability/projects/${uid(78)}/forecast`,
        body: { costToComplete: '1' },
      }),
    );
    expect([missing.status, errorCode(missing.body)]).toEqual([404, 'project_not_found']);
    const hidden = await json(
      call({ method: 'PUT', url, body: { costToComplete: '1' }, user: PM2 }),
    );
    expect(hidden.status).toBe(404);
    const badKey = await kit.app.inject({
      method: 'PUT',
      url,
      headers: { ...(await kit.auth(MANAGEMENT)), 'idempotency-key': '' },
      payload: { costToComplete: '1' },
    });
    expect(badKey.statusCode).toBe(400);
  });
});

describe('thresholds', () => {
  const body = { marginFloorPercent: '20', overspendPercent: '100', receivableAgeDays: 30 };

  it('creates, lists, updates and removes thresholds (idempotent, with version checks)', async () => {
    const key = newKey();
    const first = await json<ThresholdDto>(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'company', ...body },
        key,
      }),
    );
    const retry = await json<ThresholdDto>(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'company', ...body },
        key,
      }),
    );
    expect([first.status, retry.status]).toEqual([201, 201]);
    expect(retry.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({
      scope: 'company',
      marginFloorPercent: '20.0000',
      version: 1,
    });

    const list = await json<ThresholdDto[]>(
      call({ url: '/profitability/thresholds', user: ACCOUNTANT }),
    );
    expect(list.body.map((t) => t.id)).toContain(first.body.id);

    const url = `/profitability/thresholds/${first.body.id}`;
    const update = {
      marginFloorPercent: '25',
      overspendPercent: '90',
      receivableAgeDays: 45,
      active: false,
      version: 1,
    };
    const updated = await json<ThresholdDto>(call({ method: 'PUT', url, body: update }));
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      marginFloorPercent: '25.0000',
      active: false,
      version: 2,
    });
    const stale = await json(call({ method: 'PUT', url, body: update }));
    expect([stale.status, errorCode(stale.body)]).toEqual([409, 'version_conflict']);

    const staleDelete = await json(call({ method: 'DELETE', url: `${url}?version=1` }));
    expect([staleDelete.status, errorCode(staleDelete.body)]).toEqual([409, 'version_conflict']);
    const removed = await json(call({ method: 'DELETE', url: `${url}?version=2`, key: newKey() }));
    expect(removed.status).toBe(200);
    const gone = await json(call({ method: 'DELETE', url: `${url}?version=3` }));
    expect([gone.status, errorCode(gone.body)]).toEqual([404, 'threshold_not_found']);
    const goneUpdate = await json(call({ method: 'PUT', url, body: { ...update, version: 3 } }));
    expect(goneUpdate.status).toBe(404);
  });

  it('refuses a duplicate, bad input and a missing project', async () => {
    const created = await json<ThresholdDto>(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'company', ...body },
      }),
    );
    expect(created.status).toBe(201);
    const duplicate = await json(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'company', ...body },
      }),
    );
    expect([duplicate.status, errorCode(duplicate.body)]).toEqual([409, 'threshold_exists']);
    for (const bad of [
      { scope: 'galaxy', ...body },
      { scope: 'company', ...body, marginFloorPercent: 'x' },
      { scope: 'company', ...body, receivableAgeDays: -1 },
      { scope: 'company', ...body, receivableAgeDays: 1.5 },
      { scope: 'project', projectId: 'nope', ...body },
    ]) {
      const { status, body: out } = await json(
        call({ method: 'POST', url: '/profitability/thresholds', body: bad }),
      );
      expect([status, errorCode(out)]).toEqual([400, 'validation_failed']);
    }
    const mismatch = await json(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'project', ...body },
      }),
    );
    expect([mismatch.status, errorCode(mismatch.body)]).toEqual([400, 'invalid_scope']);
    const range = await json(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'company', ...body, marginFloorPercent: '200' },
      }),
    );
    // The numbers are checked before the company row is looked up.
    expect([range.status, errorCode(range.body)]).toEqual([400, 'invalid_threshold']);
    const missingProject = await json(
      call({
        method: 'POST',
        url: '/profitability/thresholds',
        body: { scope: 'project', projectId: uid(79), ...body },
      }),
    );
    expect([missingProject.status, errorCode(missingProject.body)]).toEqual([
      404,
      'project_not_found',
    ]);
    const badParam = await json(
      call({ method: 'DELETE', url: `/profitability/thresholds/${created.body.id}?version=0` }),
    );
    expect(badParam.status).toBe(400);
  });

  it('keeps management of thresholds to management; reading them to the readers', async () => {
    for (const user of [PM, ACCOUNTANT, SUPERVISOR, NOBODY]) {
      for (const request of [
        {
          method: 'POST' as const,
          url: '/profitability/thresholds',
          body: { scope: 'company', ...body },
        },
        {
          method: 'PUT' as const,
          url: `/profitability/thresholds/${uid(5)}`,
          body: { ...body, version: 1 },
        },
        { method: 'DELETE' as const, url: `/profitability/thresholds/${uid(5)}?version=1` },
      ]) {
        const { status, body: out } = await json(call({ ...request, user }));
        expect([status, errorCode(out)], `${user} ${request.method}`).toEqual([
          403,
          'permission_denied',
        ]);
      }
    }
    for (const user of [SUPERVISOR, NOBODY]) {
      expect((await json(call({ url: '/profitability/thresholds', user }))).status).toBe(403);
    }
    expect((await json(call({ url: '/profitability/thresholds', anonymous: true }))).status).toBe(
      401,
    );
  });
});

describe('GET /profitability/alerts', () => {
  it('lists the alerts the caller may see, open ones when asked', async () => {
    // The company thresholds from the tests above are in place; run the job once.
    kit.now.current = new Date('2026-12-31T10:00:00Z');
    const list = await kit.db.query<{ id: string }>(
      'select id from pft_thresholds where deleted_at is null',
    );
    expect(list.length).toBeGreaterThan(0);
    await kit.db.transaction((tx) => kit.profitability.evaluateAlerts(tx));
    kit.now.current = new Date('2026-10-25T10:00:00Z');
    const all = await json<AlertDto[]>(call({ url: '/profitability/alerts' }));
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body[0]?.clearedAt).toBeNull();
    expect(all.body[0]?.projectCode).toMatch(/^P-\d{4}$/);
    const open = await json<AlertDto[]>(
      call({ url: '/profitability/alerts?onlyOpen=true', user: ACCOUNTANT }),
    );
    expect(open.body.every((alert) => alert.clearedAt === null)).toBe(true);
    const own = await json<AlertDto[]>(
      call({ url: '/profitability/alerts?onlyOpen=false', user: PM2 }),
    );
    expect(own.body.every((alert) => alert.projectId !== project.id)).toBe(true);
  });

  it('refuses a bad flag and denies other roles', async () => {
    const bad = await json(call({ url: '/profitability/alerts?onlyOpen=maybe' }));
    expect([bad.status, errorCode(bad.body)]).toEqual([400, 'validation_failed']);
    for (const user of [SUPERVISOR, NOBODY]) {
      expect((await json(call({ url: '/profitability/alerts', user }))).status).toBe(403);
    }
    expect((await json(call({ url: '/profitability/alerts', anonymous: true }))).status).toBe(401);
  });
});
