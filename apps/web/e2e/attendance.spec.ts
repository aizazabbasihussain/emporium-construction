import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one
// attendance sheet: the supervisor fills the sheet of the team for a day and submits it, then the
// project manager approves it from the approvals inbox. No backend runs.
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
const DATE = '2026-10-23';

const profiles = {
  supervisor: {
    id: SUPERVISOR,
    email: 'supervisor@example.test',
    fullName: 'Site Supervisor',
    locale: 'en',
    version: 1,
    roles: ['supervisor'],
    permissions: [
      'attendance.sheet.create',
      'attendance.sheet.update',
      'attendance.sheet.read',
      'workforce.worker.read',
      'projects.project.read',
    ],
    scopes: [{ type: 'team', id: 't1' }],
  },
  manager: {
    id: MANAGER,
    email: 'pm@example.test',
    fullName: 'Project Manager',
    locale: 'en',
    version: 1,
    roles: ['project_manager'],
    permissions: [
      'attendance.sheet.read',
      'attendance.sheet.unlock',
      'approvals.inbox.read',
      'approvals.request.act',
      'workforce.worker.read',
      'projects.project.read',
    ],
    scopes: [],
  },
};

interface State {
  user: keyof typeof profiles;
  sheet: Record<string, unknown> | null;
}

const page_ = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

const members = [
  { workerId: 'w1', code: 'WK-0001', fullName: 'Ali Raza', tradeCode: 'mason' },
  { workerId: 'w2', code: 'WK-0002', fullName: 'Bilal Khan', tradeCode: 'helper' },
];

function api(state: State) {
  return async (route: Route) => {
    const request = route.request();
    if (request.resourceType() === 'document') return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const approval = () => ({
      status: state.sheet?.status === 'submitted' ? 'pending' : 'none',
      requestId: null,
      currentRole: null,
      lastComment: null,
    });
    const sheet = () => (state.sheet === null ? null : { ...state.sheet, approval: approval() });

    if (url.pathname === '/workforce/teams') {
      return json([
        {
          id: 't1',
          code: 'TM-001',
          name: 'Masons',
          supervisorUserId: SUPERVISOR,
          active: true,
          version: 1,
        },
      ]);
    }
    if (url.pathname === '/projects') {
      return json(page_([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall', status: 'active' }]));
    }
    if (url.pathname === '/attendance/grid') {
      return json({ teamId: 't1', date: DATE, members, sheet: sheet() });
    }
    if (url.pathname === `/attendance/sheets/t1/${DATE}` && request.method() === 'PUT') {
      const body = request.postDataJSON() as { entries: { workerId: string; status: string }[] };
      state.sheet = {
        id: 's1',
        teamId: 't1',
        sheetDate: DATE,
        status: 'draft',
        total: null,
        submittedBy: null,
        submittedAt: null,
        approvedBy: null,
        approvedAt: null,
        unlockReason: null,
        version: 1,
        entries: body.entries.map((entry, index) => ({
          id: `e${index}`,
          lineNo: index + 1,
          workerCode: members.find((m) => m.workerId === entry.workerId)?.code,
          workerName: members.find((m) => m.workerId === entry.workerId)?.fullName,
          overtimeHours: '0.00',
          overtimeProjectId: null,
          remarks: null,
          dayValue: null,
          overtimeValue: null,
          allocations: [],
          ...entry,
        })),
      };
      return json(sheet());
    }
    if (url.pathname === '/attendance/sheets/s1/submit') {
      state.sheet = { ...state.sheet, status: 'submitted', version: 2 };
      return json(sheet());
    }
    if (url.pathname === '/attendance/sheets') {
      return json(
        page_(
          state.sheet === null
            ? []
            : [{ ...state.sheet, total: state.user === 'manager' ? '2000.00' : null }],
        ),
      );
    }
    if (url.pathname === '/approvals/inbox') {
      return json({
        items:
          state.sheet?.status === 'submitted'
            ? [
                {
                  id: 'r1',
                  docType: 'attendance_sheet',
                  docId: 's1',
                  revision: 1,
                  amount: '2000.00',
                  requesterId: SUPERVISOR,
                  status: 'pending',
                  currentStep: 1,
                  currentRole: 'project_manager',
                  submittedAt: '2026-10-24T05:00:00Z',
                  version: 1,
                  steps: [{ stepNo: 1, roleCode: 'project_manager', minApprovers: 1 }],
                  actions: [],
                },
              ]
            : [],
      });
    }
    if (url.pathname === '/approvals/requests/r1/approve') {
      state.sheet = { ...state.sheet, status: 'approved', total: '2000.00', version: 3 };
      return json({ id: 'r1', status: 'approved' });
    }
    return json(page_([]));
  };
}

async function mockBackend(page: Page) {
  const state: State = { user: 'supervisor', sheet: null };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profiles[state.user] }));
  await page.route(
    (url) =>
      url.pathname.startsWith('/attendance') ||
      url.pathname.startsWith('/approvals') ||
      url.pathname.startsWith('/workforce') ||
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

test('a supervisor fills and submits the attendance sheet and the project manager approves it', async ({
  page,
}) => {
  const state = await mockBackend(page);
  await signIn(page, 'supervisor@example.test');

  // The supervisor opens the grid of the team for the day. The only active project is preselected.
  await page.goto(`/attendance/grid?team=t1&date=${DATE}`);
  await expect(page.getByText('WK-0001 Ali Raza')).toBeVisible();
  await page.getByLabel('Status WK-0002').selectOption('half_day');
  await page.getByLabel('Overtime (hours) WK-0001').fill('2');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Sheet submitted')).toBeVisible();
  expect(state.sheet).toMatchObject({ status: 'submitted' });
  await expect(page.getByText('Submitted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Remarks WK-0001')).toBeDisabled();

  // The project manager opens the approvals inbox and approves the sheet.
  await page.getByRole('button', { name: 'Sign out' }).click();
  state.user = 'manager';
  await signIn(page, 'pm@example.test');
  await page.getByRole('menuitem', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: /Open attendance_sheet/ }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Your decision was recorded.')).toBeVisible();
  expect(state.sheet).toMatchObject({ status: 'approved' });

  // The sheet now shows as approved, with its cost, in the list.
  await page.getByRole('menuitem', { name: 'Attendance sheets' }).click();
  await expect(page.getByRole('table').getByText('Approved', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByText('2,000')).toBeVisible();
});
