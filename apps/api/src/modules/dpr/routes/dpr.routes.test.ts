import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  createDprKit,
  type DprKit,
} from '../test-support.js';
import type { MissingReportDto, PageResult, ReportDto, ReportHeaderDto } from '../types.js';

let kit: DprKit;
let project: { id: string; code: string };
beforeAll(async () => {
  kit = await createDprKit();
  project = await kit.project();
  await kit.assign(project.id, SUPERVISOR);
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = SUPERVISOR, body, key }: Call) => {
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
const newKey = () => `dpr-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';
let dayCounter = 0;
/** A distinct, allowed report date for each test (the kit's today is 2026-10-25). */
const nextDate = () => ['2026-10-25', '2026-10-24', '2026-10-23', '2026-10-22'][dayCounter++ % 4];

const createBody = (over: Record<string, unknown> = {}) => ({
  projectId: project.id,
  reportDate: '2026-10-25',
  weather: 'cloudy',
  workDone: 'Block work up to the lintel level',
  ...over,
});

describe('POST /dpr/reports', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const payload = createBody({ reportDate: nextDate() });
    const key = newKey();
    const first = await call({ method: 'POST', url: '/dpr/reports', body: payload, key });
    const second = await call({ method: 'POST', url: '/dpr/reports', body: payload, key });
    expect(first.status).toBe(201);
    expect((second.body as ReportDto).id).toBe((first.body as ReportDto).id);
    const changed = await call({
      method: 'POST',
      url: '/dpr/reports',
      body: { ...payload, workDone: 'Something else entirely' },
      key,
    });
    expect(changed.status).toBe(422);
    const empty = await call({ method: 'POST', url: '/dpr/reports', body: payload, key: '' });
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body', async () => {
    const bad = [
      createBody({ projectId: 'x' }),
      createBody({ reportDate: '25/10/2026' }),
      createBody({ weather: 'snow' }),
      createBody({ workDone: 'w'.repeat(5001) }),
      createBody({ manpowerManual: [{ trade: '', count: 1 }] }),
      createBody({ manpowerManual: [{ trade: 'Mason', count: 1.5 }] }),
      createBody({ taskUpdates: [{ taskId: MISSING, percentComplete: 101 }] }),
      createBody({ materialNotes: [{ description: 'Sand', quantity: '1.23456' }] }),
    ];
    for (const payload of bad) {
      expect((await call({ method: 'POST', url: '/dpr/reports', body: payload })).status).toBe(400);
    }
  });

  it('refuses a caller without the permission, a project out of scope and a bad date', async () => {
    const body = createBody({ reportDate: '2026-10-21' });
    expect((await call({ method: 'POST', url: '/dpr/reports', user: NOBODY, body })).status).toBe(
      403,
    );
    expect(
      (await call({ method: 'POST', url: '/dpr/reports', user: ACCOUNTANT, body })).status,
    ).toBe(403);
    const other = await kit.project();
    const outOfScope = await call({
      method: 'POST',
      url: '/dpr/reports',
      body: createBody({ projectId: other.id }),
    });
    expect(outOfScope.status).toBe(404);
    expect(errorCode(outOfScope)).toBe('project_not_found');
    const tooOld = await call({ method: 'POST', url: '/dpr/reports', body });
    expect(errorCode(tooOld)).toBe('backdating_not_allowed');
    const future = await call({
      method: 'POST',
      url: '/dpr/reports',
      body: createBody({ reportDate: '2026-10-26' }),
    });
    expect(errorCode(future)).toBe('date_in_future');
    const unauthenticated = await kit.app.inject({ method: 'GET', url: '/dpr/reports' });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('reports a second report of the same author, project and date as a conflict', async () => {
    const body = createBody({ reportDate: '2026-10-22' });
    expect((await call({ method: 'POST', url: '/dpr/reports', body })).status).toBe(201);
    const again = await call({ method: 'POST', url: '/dpr/reports', body });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('report_exists');
  });
});

describe('GET /dpr/reports', () => {
  it('lists with filters and limits a supervisor to assigned projects', async () => {
    const created = await call({
      method: 'POST',
      url: '/dpr/reports',
      user: PM,
      body: createBody({ reportDate: '2026-10-24' }),
    });
    expect(created.status).toBe(201);
    const manager = await call({
      method: 'GET',
      url: `/dpr/reports?projectId=${project.id}`,
      user: PM,
    });
    const rows = (manager.body as PageResult<ReportHeaderDto>).items;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.projectId === project.id)).toBe(true);
    const mine = await call({
      method: 'GET',
      url: '/dpr/reports?mine=true&status=draft',
      user: PM,
    });
    expect((mine.body as PageResult<ReportHeaderDto>).items.every((r) => r.authorId === PM)).toBe(
      true,
    );
    const window = await call({
      method: 'GET',
      url: '/dpr/reports?from=2026-10-24&to=2026-10-24&limit=5&offset=0',
      user: MANAGEMENT,
    });
    expect(window.status).toBe(200);
    const stranger = await call({ method: 'GET', url: '/dpr/reports', user: SUPERVISOR2 });
    expect((stranger.body as PageResult<ReportHeaderDto>).items).toEqual([]);
    expect((await call({ method: 'GET', url: '/dpr/reports?limit=0' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/dpr/reports', user: NOBODY })).status).toBe(403);
  });
});

describe('GET, PATCH and the transitions of /dpr/reports/:id', () => {
  it('gets one report; unknown, out-of-scope and unauthorised callers get no report', async () => {
    const fresh = await call({
      method: 'POST',
      url: '/dpr/reports',
      user: PM,
      body: createBody({ reportDate: '2026-10-23' }),
    });
    const id = (fresh.body as ReportDto).id;
    const found = await call({ method: 'GET', url: `/dpr/reports/${id}`, user: ACCOUNTANT });
    expect(found.status).toBe(200);
    expect((found.body as ReportDto).photoCount).toBe(0);
    expect((await call({ method: 'GET', url: `/dpr/reports/${MISSING}` })).status).toBe(404);
    expect(
      (await call({ method: 'GET', url: `/dpr/reports/${id}`, user: SUPERVISOR2 })).status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: `/dpr/reports/${id}`, user: NOBODY })).status).toBe(
      403,
    );
    expect((await call({ method: 'GET', url: '/dpr/reports/not-a-uuid' })).status).toBe(400);
  });

  it('runs the whole flow: save, submit, reopen, correct, resubmit, review', async () => {
    // A fresh project, so no earlier test holds a report of this supervisor for the date.
    const own = await kit.project();
    await kit.assign(own.id, SUPERVISOR);
    const draft = (
      await call({
        method: 'POST',
        url: '/dpr/reports',
        body: createBody({ projectId: own.id }),
        key: newKey(),
      })
    ).body as ReportDto;

    const patched = await call({
      method: 'PATCH',
      url: `/dpr/reports/${draft.id}`,
      body: {
        version: draft.version,
        issues: 'Shuttering delayed by rain',
        manpowerManual: [{ trade: 'Mason', count: 5 }],
        materialNotes: [{ description: 'Cement', quantity: '20', unitCode: 'bag' }],
      },
      key: newKey(),
    });
    expect(patched.status).toBe(200);
    const saved = patched.body as ReportDto;
    expect(saved).toMatchObject({
      issues: 'Shuttering delayed by rain',
      version: draft.version + 1,
    });

    // Stale version, other author, validation, missing report.
    const stale = await call({
      method: 'PATCH',
      url: `/dpr/reports/${draft.id}`,
      body: { version: draft.version, issues: 'late edit' },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/dpr/reports/${draft.id}`,
          user: PM,
          body: { version: saved.version },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/dpr/reports/${draft.id}`,
          body: { version: 0 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ method: 'PATCH', url: `/dpr/reports/${MISSING}`, body: { version: 1 } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'PATCH',
          url: `/dpr/reports/${draft.id}`,
          user: NOBODY,
          body: { version: 1 },
        })
      ).status,
    ).toBe(403);

    // No photo yet: the submission is refused.
    const noPhoto = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/submit`,
      body: { version: saved.version },
    });
    expect(noPhoto.status).toBe(422);
    expect(errorCode(noPhoto)).toBe('photo_required');
    await kit.photo(draft.id, SUPERVISOR, [{ type: 'project', id: own.id }]);
    const key = newKey();
    const submitBody = { version: saved.version };
    const submitted = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/submit`,
      body: submitBody,
      key,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'submitted', photoCount: 1 });
    const replay = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/submit`,
      body: submitBody,
      key,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as ReportDto).version).toBe((submitted.body as ReportDto).version);

    // A submitted report is read-only for the author.
    const locked = await call({
      method: 'PATCH',
      url: `/dpr/reports/${draft.id}`,
      body: { version: (submitted.body as ReportDto).version, issues: 'x' },
    });
    expect(errorCode(locked)).toBe('report_read_only');

    // The supervisor cannot review; the manager reopens, the author corrects, then review.
    const sub = submitted.body as ReportDto;
    expect(
      (
        await call({
          method: 'POST',
          url: `/dpr/reports/${draft.id}/review`,
          body: { version: sub.version },
        })
      ).status,
    ).toBe(403);
    const reopened = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/reopen`,
      user: PM,
      body: { version: sub.version, note: 'Add the east wall photo' },
      key: newKey(),
    });
    expect(reopened.body).toMatchObject({
      status: 'reopened',
      reviewNote: 'Add the east wall photo',
    });
    const reopenedDto = reopened.body as ReportDto;
    const corrected = await call({
      method: 'PATCH',
      url: `/dpr/reports/${draft.id}`,
      body: { version: reopenedDto.version, safetyNotes: 'Helmets checked' },
    });
    const again = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/submit`,
      body: { version: (corrected.body as ReportDto).version },
    });
    expect((again.body as ReportDto).status).toBe('submitted');
    const reviewed = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/review`,
      user: MANAGEMENT,
      body: { version: (again.body as ReportDto).version, note: 'Good' },
      key: newKey(),
    });
    expect(reviewed.body).toMatchObject({ status: 'reviewed', reviewedBy: MANAGEMENT });
    const done = reviewed.body as ReportDto;
    const final = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/reopen`,
      user: PM,
      body: { version: done.version },
    });
    expect(errorCode(final)).toBe('report_transition');
    const staleReview = await call({
      method: 'POST',
      url: `/dpr/reports/${draft.id}/review`,
      user: PM,
      body: { version: 1 },
    });
    // A reviewed report is final, whatever version is sent.
    expect(staleReview.status).toBe(422);
    expect(errorCode(staleReview)).toBe('report_transition');
    expect(
      (
        await call({
          method: 'POST',
          url: `/dpr/reports/${draft.id}/review`,
          user: PM,
          body: { version: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: `/dpr/reports/${MISSING}/review`,
          user: PM,
          body: { version: 1 },
        })
      ).status,
    ).toBe(404);
  });
});

describe('GET /dpr/missing', () => {
  it('lists projects without a filed report for the date, for reviewers only', async () => {
    const quiet = await kit.project();
    await kit.assign(quiet.id, SUPERVISOR2);
    const response = await call({ method: 'GET', url: '/dpr/missing?date=2026-10-26', user: PM });
    expect(response.status).toBe(200);
    const rows = response.body as MissingReportDto[];
    expect(rows.find((r) => r.projectId === quiet.id)).toMatchObject({
      date: '2026-10-26',
      supervisorIds: [SUPERVISOR2],
    });
    expect((await call({ method: 'GET', url: '/dpr/missing?date=2026-10-26' })).status).toBe(403);
    expect((await call({ method: 'GET', url: '/dpr/missing', user: PM })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/dpr/missing?date=26-10', user: PM })).status).toBe(
      400,
    );
    expect(
      (await call({ method: 'GET', url: '/dpr/missing?date=2026-13-40', user: PM })).status,
    ).toBe(400);
  });
});
