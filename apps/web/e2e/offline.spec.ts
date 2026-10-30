import { expect, test, type Page, type Route } from '@playwright/test';

// A supervisor fills a daily report with two photos while the connection is down, reloads, and
// goes back online. The mocked API keeps the state of the report and honours Idempotency-Key, and
// the first answer is thrown away, so the app has to repeat a request that already succeeded.
const SUPABASE = 'http://localhost:54321';
const SUPERVISOR = '018f2222-0000-7000-8000-000000000005';

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
    email: 'supervisor@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
  },
};

const profile = {
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
};

interface Server {
  /** Reports actually created (not requests received). */
  reports: Record<string, unknown>[];
  reportRequests: number;
  uploads: { key: string | undefined; entityId: string; fileName: string }[];
  /** Throw away the answer to the next create request after it has been processed. */
  loseNextAnswer: boolean;
  /** The mocked API answers even when the browser is set offline, so it refuses on its own. */
  offline: boolean;
  seen: Map<string, unknown>;
}

const list = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

async function mockBackend(page: Page): Promise<Server> {
  const server: Server = {
    reports: [],
    reportRequests: 0,
    uploads: [],
    loseNextAnswer: false,
    offline: false,
    seen: new Map(),
  };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) =>
    server.offline ? route.abort('internetdisconnected') : route.fulfill({ json: profile }),
  );
  await page.route(
    (url) =>
      url.pathname.startsWith('/dpr') ||
      url.pathname.startsWith('/files') ||
      url.pathname.startsWith('/projects'),
    async (route: Route) => {
      const request = route.request();
      if (request.resourceType() === 'document') return route.fallback();
      if (server.offline) return route.abort('internetdisconnected');
      const url = new URL(request.url());
      const key = request.headers()['idempotency-key'];
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

      if (url.pathname === '/projects/p1/tasks') return json([]);
      if (url.pathname === '/projects') {
        return json(list([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]));
      }
      if (url.pathname === '/files' && request.method() === 'POST') {
        const replay = key === undefined ? undefined : server.seen.get(`files:${key}`);
        if (replay !== undefined) return json(replay, 201);
        const body = request.postData() ?? '';
        const entityId = /name="entityId"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? '';
        const fileName = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
        server.uploads.push({ key, entityId, fileName });
        const attachment = { id: `f${server.uploads.length}`, entityType: 'dpr_report', entityId };
        if (key !== undefined) server.seen.set(`files:${key}`, attachment);
        return json(attachment, 201);
      }
      if (url.pathname === '/dpr/reports' && request.method() === 'POST') {
        server.reportRequests += 1;
        let created = key === undefined ? undefined : server.seen.get(`dpr:${key}`);
        if (created === undefined) {
          created = {
            id: `r${server.reports.length + 1}`,
            authorId: SUPERVISOR,
            status: 'draft',
            version: 1,
            issues: '',
            safetyNotes: '',
            manpowerManual: [],
            taskUpdates: [],
            materialNotes: [],
            photoCount: 0,
            submittedAt: null,
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: null,
            ...(request.postDataJSON() as object),
          };
          server.reports.push(created as Record<string, unknown>);
          if (key !== undefined) server.seen.set(`dpr:${key}`, created);
        }
        if (server.loseNextAnswer) {
          server.loseNextAnswer = false;
          return route.abort('connectionreset');
        }
        return json(created, 201);
      }
      if (url.pathname === '/dpr/reports') return json(list(server.reports));
      return json(list([]));
    },
  );
  return server;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('supervisor@example.test');
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
}

/** Waits until the service worker controls the page, then loads it again so it is all cached. */
async function installShell(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
}

// A 1x1 PNG; the second photo carries one extra trailing byte so the two differ.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const photo = (name: string, extra: number) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.concat([PNG, Buffer.from([extra])]),
});

test('a report with two photos filled offline is delivered exactly once', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const server = await mockBackend(page);
  await signIn(page);
  await installShell(page);

  await page.getByRole('menuitem', { name: 'Daily progress reports' }).click();
  await page.getByRole('button', { name: 'New report' }).click();
  // Let the project list arrive before opening it, or the options are replaced under the click.
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Project').click();
  await page.getByTitle('PRJ-0001 Boundary wall').click();
  await expect(page.getByText('Choose a project and a date.')).toHaveCount(0);

  // The connection drops; the supervisor keeps working.
  server.offline = true;
  await context.setOffline(true);
  await expect(page.getByText('Offline')).toBeVisible();
  await page.getByLabel('Work done').fill('Poured the first lift of the roof slab');
  await page
    .getByLabel('Attach a file')
    .setInputFiles([photo('north.png', 1), photo('south.png', 2)]);
  await expect(page.getByText('north.png')).toBeVisible();
  await expect(page.getByText('south.png')).toBeVisible();

  // Reloading while offline does not lose the form (AC-3): the shell opens and offers the draft.
  await page.waitForTimeout(800); // the draft is written 500 ms after the last change
  await page.reload();
  await expect(page.getByText(/A draft saved on this device was found/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore draft' }).click();
  await expect(page.getByLabel('Work done')).toHaveValue('Poured the first lift of the roof slab');
  await expect(page.getByText('north.png')).toBeVisible();
  await expect(page.getByText('south.png')).toBeVisible();

  // Saving offline queues the report.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Saved on this device, will be sent when you are back online.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /1 unsent item/ })).toBeVisible();
  expect(server.reports).toHaveLength(0);

  // The connection returns, but the first answer is lost: the report is created on the server
  // and the app never hears of it, so it sends the same request again.
  server.loseNextAnswer = true;
  server.offline = false;
  await context.setOffline(false);
  await expect(page.getByText('Everything is sent')).toBeVisible({ timeout: 30_000 });

  expect(server.reportRequests).toBeGreaterThanOrEqual(2);
  expect(server.reports).toHaveLength(1);
  expect(server.reports[0]).toMatchObject({
    projectId: 'p1',
    workDone: 'Poured the first lift of the roof slab',
  });
  // Both photos reached the new report, once each.
  expect(server.uploads.map((u) => u.entityId)).toEqual(['r1', 'r1']);
  expect(server.uploads.map((u) => u.fileName).sort()).toEqual(['north.png', 'south.png']);
  expect(new Set(server.uploads.map((u) => u.key)).size).toBe(2);
});

test('the shell opens offline and no API answer is ever cached', async ({ page, context }) => {
  const server = await mockBackend(page);
  await signIn(page);
  await installShell(page);

  server.offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
  await expect(page.getByText('Offline')).toBeVisible();

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  const paths = cached.map((u) => new URL(u).pathname);
  for (const forbidden of ['/me', '/dpr', '/files', '/projects']) {
    expect(paths.filter((p) => p.startsWith(forbidden))).toEqual([]);
  }
});
