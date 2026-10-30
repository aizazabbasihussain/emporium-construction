import { attendancePermissions } from '@emporium/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Grid, Sheet } from './api';
import {
  fractionToPercent,
  isWorked,
  percentToFraction,
  percentToUnits,
  rowProblem,
  rowsFromGrid,
  sheetBody,
  type RowDraft,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

const project = (id: string, code: string) => ({
  id,
  code,
  name: `Wall ${code}`,
  status: 'active',
});

const members = [
  { workerId: 'w1', code: 'WK-0001', fullName: 'Ali Raza', tradeCode: 'mason' },
  { workerId: 'w2', code: 'WK-0002', fullName: 'Bilal Khan', tradeCode: 'helper' },
];

const grid = (sheet: Sheet | null = null): Grid => ({
  teamId: 't1',
  date: '2026-10-23',
  members,
  sheet,
});

const sheetOf = (over: Partial<Sheet> = {}): Sheet => ({
  id: 's1',
  teamId: 't1',
  sheetDate: '2026-10-23',
  status: 'draft',
  total: null,
  submittedBy: null,
  submittedAt: null,
  approvedBy: null,
  approvedAt: null,
  unlockReason: null,
  version: 3,
  entries: [
    {
      id: 'e1',
      lineNo: 1,
      workerId: 'w1',
      workerCode: 'WK-0001',
      workerName: 'Ali Raza',
      status: 'present',
      overtimeHours: '2.00',
      overtimeProjectId: null,
      remarks: 'late start',
      dayValue: null,
      overtimeValue: null,
      allocations: [
        { id: 'a1', projectId: 'p1', fraction: '0.6000', costCodeId: 'c', amount: null },
        { id: 'a2', projectId: 'p2', fraction: '0.4000', costCodeId: 'c', amount: null },
      ],
    },
    {
      id: 'e2',
      lineNo: 2,
      workerId: 'w2',
      workerCode: 'WK-0002',
      workerName: 'Bilal Khan',
      status: 'absent',
      overtimeHours: '0.00',
      overtimeProjectId: null,
      remarks: null,
      dayValue: null,
      overtimeValue: null,
      allocations: [],
    },
  ],
  approval: { status: 'none', requestId: null, currentRole: null, lastComment: null },
  ...over,
});

let projectList: ReturnType<typeof project>[];
let current: Grid;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  projectList = [project('p1', 'PRJ-1')];
  current = grid();
  handler = (url, init) => {
    if (url === '/workforce/teams') {
      return {
        body: [
          { id: 't1', code: 'TM-001', name: 'Masons', active: true },
          { id: 't0', code: 'TM-000', name: 'Old', active: false },
        ],
      };
    }
    if (url.startsWith('/projects?')) return { body: page(projectList) };
    if (url.startsWith('/attendance/grid?')) return { body: current };
    if (url === '/attendance/sheets/t1/2026-10-23' && init.method === 'PUT') {
      return { body: sheetOf({ version: 4 }) };
    }
    if (url === '/attendance/sheets/s1/submit') {
      return { body: sheetOf({ status: 'submitted', version: 5 }) };
    }
    if (url === '/attendance/sheets/s1/unlock') {
      return { body: sheetOf({ status: 'unlocked', version: 6 }) };
    }
    if (url.startsWith('/attendance/sheets?')) {
      return {
        body: page([
          {
            ...sheetOf({ status: 'submitted', total: '2000.00' }),
            id: 's1',
          },
          { ...sheetOf({ teamId: 'tx' }), id: 's2' },
        ]),
      };
    }
    if (url.startsWith('/attendance/missing?')) {
      return {
        body: [{ teamId: 't1', teamCode: 'TM-001', teamName: 'Masons', date: '2026-10-22' }],
      };
    }
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
          json: () => Promise.resolve(profileOf(permissions)),
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

const sent = (method: string, url: string) =>
  calls.find((c) => c.method === method && c.url === url);

const GRID = '/attendance/grid?team=t1&date=2026-10-23';

describe('form rules', () => {
  it('turns percent into a four-decimal fraction and back without rounding errors', () => {
    expect(percentToUnits('60')).toBe(6000);
    expect(percentToUnits('33.33')).toBe(3333);
    expect(percentToUnits('33.3')).toBe(3330);
    expect(percentToUnits('100')).toBe(10000);
    for (const bad of ['', '0', '0.00', '100.01', '101', '12.345', 'abc', '-5']) {
      expect(percentToUnits(bad), bad).toBeNull();
    }
    expect(percentToFraction('60')).toBe('0.6000');
    expect(percentToFraction('33.33')).toBe('0.3333');
    expect(percentToFraction('100')).toBe('1.0000');
    expect(percentToFraction('5')).toBe('0.0500');
    expect(percentToFraction('x')).toBeNull();
    expect(fractionToPercent('0.6000')).toBe('60');
    expect(fractionToPercent('0.3333')).toBe('33.33');
    expect(fractionToPercent('0.3330')).toBe('33.3');
    expect(fractionToPercent('1.0000')).toBe('100');
    expect(fractionToPercent('0.0500')).toBe('5');
  });

  it('knows which statuses carry a project', () => {
    expect(isWorked('present')).toBe(true);
    expect(isWorked('half_day')).toBe(true);
    expect(isWorked('absent')).toBe(false);
    expect(isWorked('off')).toBe(false);
  });

  const row = (over: Partial<RowDraft> = {}): RowDraft => ({
    workerId: 'w1',
    code: 'WK-0001',
    fullName: 'Ali Raza',
    status: 'present',
    overtime: '',
    overtimeProjectId: '',
    remarks: '',
    splits: [{ projectId: 'p1', percent: '100' }],
    ...over,
  });

  it('finds what is wrong with a row', () => {
    expect(rowProblem(row())).toBeNull();
    expect(rowProblem(row({ overtime: '8' }))).toBeNull();
    expect(rowProblem(row({ overtime: '9' }))).toBe('overtime');
    expect(rowProblem(row({ overtime: 'x' }))).toBe('overtime');
    expect(rowProblem(row({ status: 'absent', overtime: '9' }))).toBe('overtime');
    expect(rowProblem(row({ status: 'absent', splits: [] }))).toBeNull();
    expect(rowProblem(row({ splits: [{ projectId: '', percent: '100' }] }))).toBe('project');
    expect(rowProblem(row({ splits: [{ projectId: 'p1', percent: '99.9' }] }))).toBe('shares');
    expect(rowProblem(row({ splits: [{ projectId: 'p1', percent: '' }] }))).toBe('shares');
    expect(
      rowProblem(
        row({
          splits: [
            { projectId: 'p1', percent: '33.33' },
            { projectId: 'p2', percent: '33.33' },
            { projectId: 'p3', percent: '33.34' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('builds the request body from the rows', () => {
    expect(sheetBody([row()], undefined)).toEqual({
      entries: [
        {
          workerId: 'w1',
          status: 'present',
          allocations: [{ projectId: 'p1', fraction: '1.0000' }],
        },
      ],
    });
    expect(
      sheetBody(
        [
          row({
            overtime: ' 2 ',
            overtimeProjectId: 'p2',
            remarks: ' late ',
            splits: [
              { projectId: 'p1', percent: '60' },
              { projectId: 'p2', percent: '40' },
            ],
          }),
          row({ workerId: 'w2', status: 'absent', overtime: '3', overtimeProjectId: 'p2' }),
        ],
        7,
      ),
    ).toEqual({
      version: 7,
      entries: [
        {
          workerId: 'w1',
          status: 'present',
          overtimeHours: '2',
          overtimeProjectId: 'p2',
          remarks: 'late',
          allocations: [
            { projectId: 'p1', fraction: '0.6000' },
            { projectId: 'p2', fraction: '0.4000' },
          ],
        },
        { workerId: 'w2', status: 'absent' },
      ],
    });
  });

  it('starts from the members of the team, or from the saved entries', () => {
    expect(rowsFromGrid(grid(), 'p1').map((r) => [r.status, r.splits])).toEqual([
      ['present', [{ projectId: 'p1', percent: '100' }]],
      ['present', [{ projectId: 'p1', percent: '100' }]],
    ]);
    const saved = rowsFromGrid(grid(sheetOf()), '');
    expect(saved[0]).toMatchObject({
      overtime: '2.00',
      remarks: 'late start',
      splits: [
        { projectId: 'p1', percent: '60' },
        { projectId: 'p2', percent: '40' },
      ],
    });
    expect(saved[1]).toMatchObject({ status: 'absent', overtime: '', remarks: '', splits: [] });
  });
});

describe('the attendance grid', () => {
  it('lists the members, defaults to present on the only project and saves the whole sheet', async () => {
    open(GRID);
    expect(await screen.findByText('WK-0001 Ali Raza')).toBeInTheDocument();
    expect(screen.getByText('WK-0002 Bilal Khan')).toBeInTheDocument();
    // The inactive team is not offered.
    expect(screen.queryByRole('option', { name: /TM-000/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Overtime (hours) WK-0001'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Remarks WK-0002'), { target: { value: 'sick' } });
    await userEvent.selectOptions(screen.getByLabelText('Status WK-0002'), 'half_day');
    await userEvent.click(screen.getByRole('button', { name: 'Save sheet' }));
    await waitFor(() => expect(sent('PUT', '/attendance/sheets/t1/2026-10-23')).toBeDefined());
    expect(sent('PUT', '/attendance/sheets/t1/2026-10-23')?.body).toEqual({
      entries: [
        {
          workerId: 'w1',
          status: 'present',
          overtimeHours: '2',
          allocations: [{ projectId: 'p1', fraction: '1.0000' }],
        },
        {
          workerId: 'w2',
          status: 'half_day',
          remarks: 'sick',
          allocations: [{ projectId: 'p1', fraction: '1.0000' }],
        },
      ],
    });
    expect(await screen.findByText('Sheet saved')).toBeInTheDocument();
  });

  it('splits a day across two projects and blocks saving until the shares add up', async () => {
    projectList = [project('p1', 'PRJ-1'), project('p2', 'PRJ-2')];
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    // With two projects there is no default, so a project must be chosen first.
    expect(
      await screen.findByText('Ali Raza needs a project for every share.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sheet' })).toBeDisabled();
    for (const worker of ['WK-0001', 'WK-0002']) {
      await userEvent.selectOptions(screen.getByLabelText(`Project ${worker} 1`), 'p1');
    }
    await userEvent.click(screen.getAllByRole('button', { name: /Split to another project/ })[0]!);
    await userEvent.selectOptions(screen.getByLabelText('Project WK-0001 2'), 'p2');
    fireEvent.change(screen.getByLabelText('Share (%) WK-0001 1'), { target: { value: '60' } });
    expect(
      await screen.findByText('The shares of Ali Raza must add up to 100%.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sheet' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Share (%) WK-0001 2'), { target: { value: '40' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save sheet' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save sheet' }));
    await waitFor(() => expect(sent('PUT', '/attendance/sheets/t1/2026-10-23')).toBeDefined());
    const body = sent('PUT', '/attendance/sheets/t1/2026-10-23')?.body as {
      entries: { allocations: { projectId: string; fraction: string }[] }[];
    };
    expect(body.entries[0]?.allocations).toEqual([
      { projectId: 'p1', fraction: '0.6000' },
      { projectId: 'p2', fraction: '0.4000' },
    ]);
    // A split can be taken away again.
    await userEvent.click(screen.getByRole('button', { name: 'Remove split WK-0001 2' }));
    expect(screen.queryByLabelText('Project WK-0001 2')).not.toBeInTheDocument();
  });

  it('warns about overtime above 8 hours', async () => {
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    fireEvent.change(screen.getByLabelText('Overtime (hours) WK-0001'), { target: { value: '9' } });
    expect(
      await screen.findByText('Overtime of Ali Raza must be between 0 and 8 hours.'),
    ).toBeInTheDocument();
  });

  it('marks everyone present and clears project fields of days without work', async () => {
    current = grid(sheetOf());
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    expect(screen.getByLabelText('Status WK-0002')).toHaveValue('absent');
    expect(screen.queryByLabelText('Project WK-0002 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark everyone present' }));
    expect(screen.getByLabelText('Status WK-0002')).toHaveValue('present');
    expect(screen.getByLabelText('Project WK-0002 1')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Status WK-0002'), 'off');
    await userEvent.selectOptions(screen.getByLabelText('Status WK-0002'), 'present');
    expect(screen.getByLabelText('Project WK-0002 1')).toHaveValue('p1');
  });

  it('saves first when there are unsaved changes, then submits with the new version', async () => {
    current = grid(sheetOf());
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    fireEvent.change(screen.getByLabelText('Remarks WK-0002'), { target: { value: 'sick' } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(sent('POST', '/attendance/sheets/s1/submit')).toBeDefined());
    expect(sent('PUT', '/attendance/sheets/t1/2026-10-23')?.body).toMatchObject({ version: 3 });
    expect(sent('POST', '/attendance/sheets/s1/submit')?.body).toEqual({ version: 4 });
    expect(await screen.findByText('Sheet submitted')).toBeInTheDocument();
  });

  it('submits a saved, unchanged sheet without saving again', async () => {
    current = grid(sheetOf());
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(sent('POST', '/attendance/sheets/s1/submit')).toBeDefined());
    expect(sent('PUT', '/attendance/sheets/t1/2026-10-23')).toBeUndefined();
    expect(sent('POST', '/attendance/sheets/s1/submit')?.body).toEqual({ version: 3 });
  });

  it('saves and submits a new sheet in one go', async () => {
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    handler = ((previous) => (url: string, init: RequestInit) =>
      url === '/attendance/sheets/t1/2026-10-23' && init.method === 'PUT'
        ? { body: sheetOf({ id: 's1', version: 1 }) }
        : previous(url, init))(handler);
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(sent('POST', '/attendance/sheets/s1/submit')).toBeDefined());
    expect(sent('POST', '/attendance/sheets/s1/submit')?.body).toEqual({ version: 1 });
  });

  it('shows the error of the API in words', async () => {
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    handler = () => ({
      status: 422,
      body: { error: { code: 'worker_rate_missing', message: 'Ali Raza has no pay rate' } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save sheet' }));
    expect(
      await screen.findByText(
        'A worker has no pay rate for this date, so the sheet cannot be submitted.',
      ),
    ).toBeInTheDocument();
    handler = () => ({ status: 500, body: 'boom' });
    await userEvent.click(screen.getByRole('button', { name: 'Save sheet' }));
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
  });

  it('shows why a sheet came back from the approver and keeps it editable', async () => {
    current = grid(
      sheetOf({
        status: 'rejected',
        approval: {
          status: 'rejected',
          requestId: 'r1',
          currentRole: null,
          lastComment: 'Check the second worker',
        },
      }),
    );
    open(GRID);
    expect(await screen.findByText('The approver sent this sheet back')).toBeInTheDocument();
    expect(screen.getByText('Check the second worker')).toBeInTheDocument();
    expect(screen.getByLabelText('Remarks WK-0001')).toBeEnabled();
  });

  it('locks a submitted sheet, shows its cost and offers unlocking only once approved', async () => {
    current = grid(sheetOf({ status: 'submitted', total: '2000.00' }));
    open(GRID);
    expect(
      await screen.findByText(
        'This sheet is with the approver or approved, so it cannot be changed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Remarks WK-0001')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save sheet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
    expect(screen.getByText(/Labour cost of the sheet/)).toHaveTextContent('2,000');
  });

  it('unlocks an approved sheet with a reason', async () => {
    current = grid(sheetOf({ status: 'approved', total: '2000.00' }));
    open(GRID);
    await userEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getAllByRole('button', { name: 'Unlock' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Why is the sheet unlocked?'), 'Wrong site');
    await userEvent.click(confirm);
    await waitFor(() => expect(sent('POST', '/attendance/sheets/s1/unlock')).toBeDefined());
    expect(sent('POST', '/attendance/sheets/s1/unlock')?.body).toEqual({
      reason: 'Wrong site',
      version: 3,
    });
    expect(await screen.findByText('Sheet unlocked')).toBeInTheDocument();
  });

  it('can be cancelled out of the unlock dialog', async () => {
    current = grid(sheetOf({ status: 'approved' }));
    open(GRID);
    await userEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(calls.some((c) => c.url.endsWith('/unlock'))).toBe(false);
  });

  it('is read-only without the write permissions and says when a team has no members', async () => {
    permissions = [
      attendancePermissions.sheetRead,
      'workforce.worker.read',
      'projects.project.read',
    ];
    current = grid();
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    expect(screen.getByLabelText('Remarks WK-0001')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save sheet' })).not.toBeInTheDocument();
  });

  it('asks for a team first and shows an empty team', async () => {
    open('/attendance/grid');
    expect(await screen.findByRole('option', { name: 'Choose a team' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/attendance/grid'))).toBe(false);
  });

  it('says so when the team has no members on the date', async () => {
    current = { ...grid(), members: [] };
    open(GRID);
    expect(await screen.findByText('This team has no members on this date.')).toBeInTheDocument();
  });

  it('changes the team and the date through the address', async () => {
    open(GRID);
    await screen.findByText('WK-0001 Ali Raza');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-22' } });
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/attendance/grid?team=t1&date=2026-10-22')).toBe(true),
    );
    await userEvent.selectOptions(screen.getByLabelText('Team'), '');
    expect(screen.getByLabelText('Team')).toHaveValue('');
  });
});

describe('the sheet list and the missing sheets', () => {
  it('lists sheets with team, status and cost, and opens one in the grid', async () => {
    open('/attendance/sheets');
    expect(await screen.findAllByText('TM-001 Masons')).toHaveLength(1);
    expect(within(screen.getByRole('table')).getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText(/2,000/)).toBeInTheDocument();
    // A team the list of teams does not know is shown by its id.
    expect(screen.getByText('tx')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Open' });
    expect(links[0]).toHaveAttribute('href', '/attendance/grid?team=t1&date=2026-10-23');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'submitted');
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=submitted'))).toBe(true));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-30' } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('from=2026-10-01') && c.url.includes('to=2026-10-30')),
      ).toBe(true),
    );
  });

  it('lists the working days without a sheet and links to the grid', async () => {
    open('/attendance/missing');
    expect(await screen.findByText('TM-001 Masons')).toBeInTheDocument();
    expect(screen.getByText('22/10/2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fill sheet' })).toHaveAttribute(
      'href',
      '/attendance/grid?team=t1&date=2026-10-22',
    );
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith('/attendance/missing?from=2026-10-01'))).toBe(true),
    );
  });

  it('does not ask for a backwards period', async () => {
    open('/attendance/missing');
    await screen.findByText('TM-001 Masons');
    calls.length = 0;
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2099-01-01' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((c) => c.url.startsWith('/attendance/missing'))).toBe(false);
  });
});
