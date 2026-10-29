import { dprPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { MissingReport, Report } from './api';
import {
  bodyOf,
  draftOf,
  emptyDraft,
  karachiToday,
  saveProblem,
  submitProblem,
  type ReportDraft,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const ME = '018f2222-0000-7000-8000-000000000001';
const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

const report = (over: Partial<Report> = {}): Report => ({
  id: 'r1',
  projectId: 'p1',
  reportDate: '2026-10-24',
  authorId: ME,
  weather: 'rain',
  status: 'draft',
  workDone: 'Poured the first lift of the slab',
  issues: 'Late cement',
  safetyNotes: '',
  manpowerManual: [{ trade: 'Mason', count: 4 }],
  submittedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  version: 3,
  taskUpdates: [{ taskId: 't1', percentComplete: 40, note: null }],
  materialNotes: [{ description: 'Cement', quantity: '12.0000', unitCode: 'bag' }],
  photoCount: 1,
  ...over,
});

let current: Report;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  current = report();
  handler = (url, init) => {
    if (url === '/dpr/reports' && init.method === 'POST') return { status: 201, body: current };
    if (url.startsWith('/dpr/reports?')) {
      return {
        body: page([
          report(),
          report({ id: 'r2', reportDate: '2026-10-23', status: 'submitted', weather: 'clear' }),
        ]),
      };
    }
    if (url.startsWith('/dpr/reports/r1')) return { body: current };
    if (url.startsWith('/dpr/missing')) {
      const rows: MissingReport[] = [
        {
          projectId: 'p1',
          code: 'PRJ-0001',
          name: 'Boundary wall',
          projectManagerId: null,
          supervisorIds: ['u1', 'u2'],
          date: '2026-10-25',
        },
      ];
      return { body: rows };
    }
    if (url.startsWith('/projects/p1/tasks')) {
      return {
        body: [
          { id: 't1', projectId: 'p1', name: 'Slab', status: 'doing', percentComplete: 20 },
          { id: 't2', projectId: 'p1', name: 'Walls', status: 'todo', percentComplete: 0 },
        ],
      };
    }
    if (url.startsWith('/projects')) {
      return { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) };
    }
    if (url.startsWith('/files')) return { body: page([]) };
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((fullUrl: string, init: RequestInit) => {
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '');
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions, { id: ME })),
        });
      }
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const { status = 200, body } = handler(url, init) ?? { body: page([]) };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const sent = (method: string, suffix: string) =>
  calls.find((c) => c.method === method && c.url.endsWith(suffix));

const filled = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  ...emptyDraft('2026-10-24'),
  projectId: 'p1',
  workDone: 'Poured the first lift of the slab',
  ...over,
});

describe('report form rules (BR-3, BR-4, T-7)', () => {
  it('needs a project and a date for a new report', () => {
    expect(saveProblem(emptyDraft('2026-10-24'), true)).toBe('projectAndDate');
    expect(saveProblem(filled({ reportDate: '' }), true)).toBe('projectAndDate');
    expect(saveProblem(filled(), true)).toBeNull();
    expect(saveProblem(emptyDraft('2026-10-24'), false)).toBeNull();
  });

  it('checks manpower, task updates and materials row by row', () => {
    for (const bad of [
      { trade: '', count: '3' },
      { trade: 'Mason', count: '' },
      { trade: 'Mason', count: '1.5' },
      { trade: 'Mason', count: '-1' },
    ]) {
      expect(saveProblem(filled({ manpower: [bad] }), false), JSON.stringify(bad)).toBe('manpower');
    }
    for (const bad of [
      { taskId: '', percent: '10', note: '' },
      { taskId: 't1', percent: '', note: '' },
      { taskId: 't1', percent: 'x', note: '' },
      { taskId: 't1', percent: '101', note: '' },
    ]) {
      expect(saveProblem(filled({ tasks: [bad] }), false), JSON.stringify(bad)).toBe('tasks');
    }
    for (const bad of [
      { description: ' ', quantity: '', unitCode: '' },
      { description: 'Sand', quantity: 'many', unitCode: '' },
      { description: 'Sand', quantity: '1.23456', unitCode: '' },
    ]) {
      expect(saveProblem(filled({ materials: [bad] }), false), JSON.stringify(bad)).toBe(
        'materials',
      );
    }
    expect(
      saveProblem(
        filled({
          manpower: [{ trade: 'Mason', count: '4' }],
          tasks: [{ taskId: 't1', percent: '100', note: '' }],
          materials: [{ description: 'Sand', quantity: '2.5', unitCode: '' }],
        }),
        false,
      ),
    ).toBeNull();
  });

  it('needs ten characters of work done to submit', () => {
    expect(submitProblem(filled({ workDone: '   short   ' }))).toBe('workDone');
    expect(submitProblem(filled({ workDone: '1234567890' }))).toBeNull();
  });

  it('converts between the form and the API shape', () => {
    const draft = filled({
      workDone: ' Slab ready for the next lift ',
      manpower: [{ trade: ' Mason ', count: '4' }],
      tasks: [
        { taskId: 't1', percent: '60', note: ' ahead ' },
        { taskId: 't2', percent: '5', note: '' },
      ],
      materials: [
        { description: ' Sand ', quantity: ' 2.5 ', unitCode: ' bag ' },
        { description: 'Bricks', quantity: '', unitCode: '' },
      ],
    });
    expect(bodyOf(draft)).toEqual({
      weather: 'clear',
      workDone: 'Slab ready for the next lift',
      issues: '',
      safetyNotes: '',
      manpowerManual: [{ trade: 'Mason', count: 4 }],
      taskUpdates: [
        { taskId: 't1', percentComplete: 60, note: 'ahead' },
        { taskId: 't2', percentComplete: 5 },
      ],
      materialNotes: [
        { description: 'Sand', quantity: '2.5', unitCode: 'bag' },
        { description: 'Bricks' },
      ],
    });
    expect(
      draftOf(report({ taskUpdates: [{ taskId: 't1', percentComplete: 0, note: 'why' }] })),
    ).toMatchObject({
      manpower: [{ trade: 'Mason', count: '4' }],
      tasks: [{ taskId: 't1', percent: '0', note: 'why' }],
      materials: [{ description: 'Cement', quantity: '12.0000', unitCode: 'bag' }],
    });
    expect(
      draftOf(report({ materialNotes: [{ description: 'Sand', quantity: null, unitCode: null }] }))
        .materials,
    ).toEqual([{ description: 'Sand', quantity: '', unitCode: '' }]);
  });

  it('gives the business date in Karachi', () => {
    // 20:00 UTC on the 24th is already past midnight in Karachi.
    expect(karachiToday(new Date('2026-10-24T20:00:00Z'))).toBe('2026-10-25');
    expect(karachiToday(new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-24');
    expect(karachiToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('report lists', () => {
  it('lists reports with a link to a new one and filters by the choices', async () => {
    open('/dpr/reports');
    expect(await screen.findByRole('link', { name: '24/10/2026' })).toBeInTheDocument();
    expect(screen.getAllByText('PRJ-0001 Boundary wall').length).toBeGreaterThan(0);
    expect(screen.getByText('Draft')).toBeVisible();
    expect(screen.getByText('Submitted')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New report' })).toBeVisible();

    await userEvent.click(screen.getByLabelText('My reports only'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('mine=true'))).toBe(true));
    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByTitle('Reviewed'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=reviewed'))).toBe(true));
    await userEvent.click(screen.getByLabelText('Project'));
    await userEvent.click(await screen.findByTitle('PRJ-0001 Boundary wall'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('projectId=p1'))).toBe(true));
  });

  it('hides New report from people who cannot report', async () => {
    permissions = allPermissions.filter((p) => p !== dprPermissions.reportCreate);
    open('/dpr/reports');
    await screen.findByRole('link', { name: '24/10/2026' });
    expect(screen.queryByRole('button', { name: 'New report' })).not.toBeInTheDocument();
  });

  it('shows an error when the list cannot be loaded', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'boom', message: 'x' } } });
    open('/dpr/reports');
    expect(await screen.findByText('Could not load data')).toBeVisible();
  });

  it('lists the missing reports of a day for reviewers', async () => {
    open('/dpr/missing');
    expect(await screen.findByText('PRJ-0001 Boundary wall')).toBeVisible();
    expect(screen.getByText('2')).toBeVisible();
    expect(calls.some((c) => /\/dpr\/missing\?date=\d{4}-\d{2}-\d{2}/.test(c.url))).toBe(true);
    await userEvent.clear(screen.getByLabelText('Date'));
    await userEvent.type(screen.getByLabelText('Date'), '2026-10-20');
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/dpr/missing?date=2026-10-20')).toBe(true),
    );
  });

  it('refuses the missing list without the review permission', async () => {
    permissions = allPermissions.filter((p) => p !== dprPermissions.reportReview);
    open('/dpr/missing');
    expect(await screen.findByText('You do not have permission to open this page.')).toBeVisible();
  });

  it('says so when nothing is missing', async () => {
    const previous = handler;
    handler = (url, init) => (url.startsWith('/dpr/missing') ? { body: [] } : previous(url, init));
    open('/dpr/missing');
    expect(await screen.findByText('Every project with a supervisor has reported.')).toBeVisible();
  });
});

describe('new report', () => {
  it('checks the form before saving, then saves and opens the report', async () => {
    open('/dpr/reports/new');
    await screen.findByRole('heading', { name: /New report/ });
    const save = () => screen.getByRole('button', { name: 'Save' });
    expect(save()).toBeDisabled();
    expect(screen.getByText('Choose a project and a date.')).toBeVisible();

    await userEvent.click(screen.getByLabelText('Project'));
    await userEvent.click(await screen.findByTitle('PRJ-0001 Boundary wall'));
    expect(save()).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Work done'), 'Shuttering of the roof slab');

    await userEvent.click(screen.getByRole('button', { name: 'Add trade' }));
    expect(save()).toBeDisabled();
    expect(screen.getByText('Each trade needs a name and a whole-number count.')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Trade 1'), 'Carpenter');
    await userEvent.type(screen.getByLabelText('Count 1'), '6');
    expect(save()).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Add task update' }));
    await userEvent.click(screen.getByLabelText('Task 1'));
    await userEvent.click(await screen.findByTitle('Slab (Now 20%)'));
    await userEvent.type(screen.getByLabelText('Percent complete 1'), '45');
    await userEvent.type(screen.getByLabelText('Note 1'), 'On track');

    await userEvent.click(screen.getByRole('button', { name: 'Add material' }));
    await userEvent.type(screen.getByLabelText('Material 1'), 'Cement');
    await userEvent.type(screen.getByLabelText('Quantity 1'), '12.5');
    await userEvent.type(screen.getByLabelText('Unit 1'), 'bag');

    await userEvent.click(save());
    await waitFor(() => expect(sent('POST', '/dpr/reports')).toBeDefined());
    expect(sent('POST', '/dpr/reports')?.body).toEqual({
      projectId: 'p1',
      reportDate: karachiToday(),
      weather: 'clear',
      workDone: 'Shuttering of the roof slab',
      issues: '',
      safetyNotes: '',
      manpowerManual: [{ trade: 'Carpenter', count: 6 }],
      taskUpdates: [{ taskId: 't1', percentComplete: 45, note: 'On track' }],
      materialNotes: [{ description: 'Cement', quantity: '12.5', unitCode: 'bag' }],
    });
    // The saved report opens, with the photo area now available.
    expect(await screen.findByText('Attachments')).toBeVisible();
  });

  it('removes rows and tells why a save was refused', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/dpr/reports' && init.method === 'POST'
        ? { status: 409, body: { error: { code: 'report_exists', message: 'dup' } } }
        : base(url, init);
    open('/dpr/reports/new');
    await userEvent.click(await screen.findByLabelText('Project'));
    await userEvent.click(await screen.findByTitle('PRJ-0001 Boundary wall'));
    await userEvent.click(screen.getByRole('button', { name: 'Add trade' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByLabelText('Trade 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('You already have a report for this project and date.'),
    ).toBeVisible();
  });

  it('needs a project before a task update can be added', async () => {
    open('/dpr/reports/new');
    await screen.findByRole('heading', { name: /New report/ });
    expect(screen.getByRole('button', { name: 'Add task update' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add material' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByLabelText('Material 1')).not.toBeInTheDocument();
  });
});

describe('an existing report', () => {
  it('edits a draft and submits what is on screen', async () => {
    const saved = report({ version: 4, issues: 'Rain stopped work' });
    const base = handler;
    handler = (url, init) => {
      if (url === '/dpr/reports/r1' && init.method === 'PATCH') return { body: saved };
      if (url === '/dpr/reports/r1/submit') {
        current = { ...saved, status: 'submitted', version: 5 };
        return { body: current };
      }
      return base(url, init);
    };
    open('/dpr/reports/r1');
    expect(await screen.findByLabelText('Work done')).toHaveValue(
      'Poured the first lift of the slab',
    );
    expect(screen.getByLabelText('Trade 1')).toHaveValue('Mason');
    expect(screen.getByLabelText('Percent complete 1')).toHaveValue('40');
    await userEvent.clear(screen.getByLabelText('Delays and issues'));
    await userEvent.type(screen.getByLabelText('Delays and issues'), 'Rain stopped work');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Report submitted.')).toBeVisible();
    const patch = sent('PATCH', '/dpr/reports/r1');
    expect(patch?.body).toMatchObject({ version: 3, issues: 'Rain stopped work' });
    expect(sent('POST', '/dpr/reports/r1/submit')?.body).toEqual({ version: 4 });
  });

  it('blocks submitting while the work done is too short', async () => {
    current = report({ workDone: 'Too short' });
    open('/dpr/reports/r1');
    expect(
      await screen.findByText(
        'Describe the work done in at least 10 characters before submitting.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows why a submission was refused', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/dpr/reports/r1' && init.method === 'PATCH'
        ? { body: current }
        : url.endsWith('/submit')
          ? { status: 422, body: { error: { code: 'photo_required', message: 'photo' } } }
          : base(url, init);
    open('/dpr/reports/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Attach at least one photo before submitting.')).toBeVisible();
  });

  it('shows a submitted report read-only to its author, with the reviewer note of a reopen', async () => {
    current = report({ status: 'submitted' });
    open('/dpr/reports/r1');
    expect(await screen.findByLabelText('Work done')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add trade' })).not.toBeInTheDocument();
  });

  it('shows the note on a reopened report and lets the author edit it', async () => {
    current = report({ status: 'reopened', reviewNote: 'Add the slab photo' });
    open('/dpr/reports/r1');
    expect(await screen.findByText('Add the slab photo')).toBeVisible();
    expect(screen.getByLabelText('Work done')).toBeEnabled();
  });

  it('lets a reviewer mark a submitted report reviewed, with a note', async () => {
    current = report({ status: 'submitted', authorId: 'someone-else' });
    const base = handler;
    handler = (url, init) => {
      if (url !== '/dpr/reports/r1/review') return base(url, init);
      current = { ...current, status: 'reviewed', version: 4 };
      return { body: current };
    };
    open('/dpr/reports/r1');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Review note'), ' Looks good ');
    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByText('Report reviewed.')).toBeVisible();
    expect(sent('POST', '/dpr/reports/r1/review')?.body).toEqual({
      version: 3,
      note: 'Looks good',
    });
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  it('lets a reviewer reopen a report without a note', async () => {
    current = report({ status: 'submitted', authorId: 'someone-else' });
    const base = handler;
    handler = (url, init) =>
      url === '/dpr/reports/r1/reopen'
        ? { body: { ...current, status: 'reopened', version: 4 } }
        : base(url, init);
    open('/dpr/reports/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen for correction' }));
    expect(await screen.findByText('Report reopened.')).toBeVisible();
    expect(sent('POST', '/dpr/reports/r1/reopen')?.body).toEqual({ version: 3 });
  });

  it('offers no review to people without the permission', async () => {
    permissions = allPermissions.filter((p) => p !== dprPermissions.reportReview);
    current = report({ status: 'submitted', authorId: 'someone-else' });
    open('/dpr/reports/r1');
    await screen.findByLabelText('Work done');
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  it('says so when the report cannot be loaded', async () => {
    handler = () => ({ status: 404, body: { error: { code: 'report_not_found', message: 'x' } } });
    open('/dpr/reports/r1');
    expect(await screen.findByText('Could not load data')).toBeVisible();
  });
});
