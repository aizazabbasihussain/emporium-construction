import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one report:
// the supervisor saves a daily report, attaches a photo and submits it, then the project manager
// opens it and marks it reviewed. No backend runs.
const SUPABASE = 'http://localhost:54321';

const session = {
  access_token: 'e2e-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'e2e-refresh-token',
  user: {
    id: 'e2e-subject',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'person@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
  },
};

const SUPERVISOR = '018f2222-0000-7000-8000-000000000005';
const MANAGER = '018f2222-0000-7000-8000-000000000003';

const profiles = {
  supervisor: {
    id: SUPERVISOR,
    email: 'supervisor@example.test',
    fullName: 'Site Supervisor',
    locale: 'en',
    version: 1,
    roles: ['supervisor'],
    permissions: [
      'dpr.report.create',
      'dpr.report.update_own',
      'dpr.report.read',
      'files.attachment.upload',
      'files.attachment.read',
      'projects.project.read',
    ],
    scopes: [{ type: 'project', id: 'p1' }],
  },
  manager: {
    id: MANAGER,
    email: 'pm@example.test',
    fullName: 'Project Manager',
    locale: 'en',
    version: 1,
    roles: ['project_manager'],
    permissions: [
      'dpr.report.read',
      'dpr.report.review',
      'files.attachment.read',
      'projects.project.read',
    ],
    scopes: [],
  },
};

interface State {
  user: keyof typeof profiles;
  report: Record<string, unknown> | null;
  photos: { id: string; fileName: string; caption: string | null }[];
}

const page_ = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

function api(state: State) {
  return async (route: Route) => {
    const request = route.request();
    if (request.resourceType() === 'document') return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const withPhotos = () => ({ ...state.report, photoCount: state.photos.length });

    if (url.pathname === '/projects/p1/tasks') {
      return json([{ id: 't1', projectId: 'p1', name: 'Roof slab', percentComplete: 20 }]);
    }
    if (url.pathname === '/projects') {
      return json(page_([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]));
    }
    if (url.pathname === '/files' && request.method() === 'POST') {
      state.photos.push({ id: 'f1', fileName: 'slab.png', caption: null });
      return json({ ...state.photos[0], entityType: 'dpr_report', contentType: 'image/png' }, 201);
    }
    if (url.pathname === '/files') {
      return json({
        items: state.photos.map((p) => ({
          ...p,
          entityType: 'dpr_report',
          entityId: 'r1',
          contentType: 'application/pdf',
          sizeBytes: 100,
          takenAt: null,
          version: 1,
        })),
      });
    }
    if (url.pathname === '/dpr/reports' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.report = {
        id: 'r1',
        authorId: SUPERVISOR,
        status: 'draft',
        issues: '',
        safetyNotes: '',
        manpowerManual: [],
        submittedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        version: 1,
        taskUpdates: [],
        materialNotes: [],
        ...body,
      };
      return json(withPhotos(), 201);
    }
    if (url.pathname === '/dpr/reports') {
      return json(page_(state.report === null ? [] : [state.report]));
    }
    if (url.pathname === '/dpr/reports/r1' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      const version = (state.report?.version as number) + 1;
      state.report = { ...state.report, ...body, version };
      return json(withPhotos());
    }
    if (url.pathname === '/dpr/reports/r1/submit') {
      const version = (state.report?.version as number) + 1;
      state.report = { ...state.report, status: 'submitted', version };
      return json(withPhotos());
    }
    if (url.pathname === '/dpr/reports/r1/review') {
      const body = request.postDataJSON() as { note?: string };
      const version = (state.report?.version as number) + 1;
      state.report = {
        ...state.report,
        status: 'reviewed',
        reviewNote: body.note ?? null,
        version,
      };
      return json(withPhotos());
    }
    if (url.pathname === '/dpr/reports/r1') return json(withPhotos());
    return json(page_([]));
  };
}

async function mockBackend(page: Page) {
  const state: State = {
    user: 'supervisor',
    report: {
      id: 'r1',
      projectId: 'p1',
      reportDate: '2026-10-24',
      authorId: SUPERVISOR,
      weather: 'clear',
      status: 'draft',
      workDone: '',
      issues: '',
      safetyNotes: '',
      manpowerManual: [],
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      version: 1,
      taskUpdates: [],
      materialNotes: [],
    },
    photos: [],
  };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profiles[state.user] }));
  await page.route(
    (url) =>
      url.pathname.startsWith('/dpr') ||
      url.pathname.startsWith('/files') ||
      url.pathname.startsWith('/projects'),
    api(state),
  );
  return state;
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
}

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('a supervisor submits a report with a photo and the project manager reviews it', async ({
  page,
}) => {
  const state = await mockBackend(page);
  await signIn(page, 'supervisor@example.test');

  // The supervisor opens today's draft for the assigned project and completes it. (Creating a
  // report is covered by the component tests; the project dropdown is not driven here.)
  await page.getByRole('menuitem', { name: 'Daily progress reports' }).click();
  await page.getByRole('link', { name: /\d{2}\/\d{2}\/\d{4}/ }).click();
  await page.getByLabel('Work done').fill('Poured the first lift of the roof slab');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Report saved.')).toBeVisible();
  expect(state.report).toMatchObject({
    projectId: 'p1',
    status: 'draft',
    workDone: 'Poured the first lift of the roof slab',
  });

  // The photo is attached, then the report is submitted.
  await page.getByLabel('Attach a file').setInputFiles({
    name: 'slab.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByText('slab.png')).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Report submitted.')).toBeVisible();
  expect(state.report).toMatchObject({ status: 'submitted' });

  // The project manager opens the report and marks it reviewed with a note.
  await page.getByRole('button', { name: 'Sign out' }).click();
  state.user = 'manager';
  await signIn(page, 'pm@example.test');
  await page.getByRole('menuitem', { name: 'Daily progress reports' }).click();
  await page.getByRole('link', { name: /\d{2}\/\d{2}\/\d{4}/ }).click();
  await expect(page.getByText('Submitted')).toBeVisible();
  await page.getByLabel('Review note').fill('Good progress');
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByText('Report reviewed.')).toBeVisible();
  expect(state.report).toMatchObject({ status: 'reviewed', reviewNote: 'Good progress' });
});
