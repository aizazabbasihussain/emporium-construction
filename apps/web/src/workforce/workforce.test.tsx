import { workforcePermissions } from '@emporium/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Rate, Team, TeamDetail, Worker } from './api';
import {
  emptyRate,
  emptyWorker,
  karachiToday,
  membersAfterMove,
  rateBody,
  rateProblem,
  workerBody,
  workerProblem,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

const worker = (over: Partial<Worker> = {}): Worker => ({
  id: 'w1',
  code: 'WK-0001',
  fullName: 'Synthetic Worker',
  fatherName: null,
  cnic: '*********4567',
  phone: null,
  tradeCode: 'mason',
  employmentType: 'daily',
  contractorPartyId: null,
  joinedOn: '2026-01-01',
  leftOn: null,
  status: 'active',
  bankOrWalletInfo: null,
  version: 2,
  ...over,
});

const member = (workerId: string, code: string, fullName: string, teamId: string) => ({
  teamId,
  workerId,
  code,
  fullName,
  tradeCode: 'mason',
  fromDate: '2026-01-01',
  toDate: null,
});

const team = (id: string, code: string, members: TeamDetail['members'] = []): TeamDetail => ({
  id,
  code,
  name: `Team ${code}`,
  supervisorUserId: 'u1',
  active: true,
  version: 4,
  members,
});

const rate: Rate = {
  id: 'r1',
  workerId: 'w1',
  payBasis: 'daily_rate',
  amount: '1000.00',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url, init) => {
    if (url === '/workforce/trades') {
      return {
        body: [
          { code: 'mason', name: 'Mason', version: 1 },
          { code: 'helper', name: 'Helper', version: 1 },
        ],
      };
    }
    if (url === '/workforce/workers' && init.method === 'POST') {
      return { status: 201, body: worker({ id: 'w9' }) };
    }
    if (url.startsWith('/workforce/workers?')) return { body: page([worker()]) };
    if (url === '/workforce/workers/w1/rates' && init.method === 'POST') {
      return { status: 201, body: rate };
    }
    if (url === '/workforce/workers/w1/rates') return { body: [rate] };
    if (url === '/workforce/workers/w1/deactivate') {
      return { body: worker({ status: 'inactive', leftOn: '2026-02-01', version: 3 }) };
    }
    if (url === '/workforce/workers/w1') return { body: worker() };
    if (url === '/workforce/teams/mine') {
      return { body: [team('t1', 'TM-001', [member('w1', 'WK-0001', 'Synthetic Worker', 't1')])] };
    }
    if (url === '/workforce/teams') {
      const teams: Team[] = [team('t1', 'TM-001'), team('t2', 'TM-002')];
      return { body: teams };
    }
    if (url === '/workforce/teams/t1') {
      return { body: team('t1', 'TM-001', [member('w1', 'WK-0001', 'Synthetic Worker', 't1')]) };
    }
    if (url === '/workforce/teams/t2') {
      return { body: team('t2', 'TM-002', [member('w2', 'WK-0002', 'Other Worker', 't2')]) };
    }
    if (url === '/workforce/teams/t2/members') return { body: team('t2', 'TM-002') };
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

describe('form rules', () => {
  it('needs a name, a trade, a date and a 13-digit CNIC when one is given', () => {
    const draft = { ...emptyWorker('2026-01-01'), fullName: 'A', tradeCode: 'mason' };
    expect(workerProblem({ ...draft, fullName: ' ' })).toBe('name');
    expect(workerProblem({ ...draft, tradeCode: '' })).toBe('trade');
    expect(workerProblem({ ...draft, joinedOn: '1/1/2026' })).toBe('joined');
    expect(workerProblem({ ...draft, cnic: '35202-123' })).toBe('cnic');
    expect(workerProblem({ ...draft, cnic: '35202-1234567-1' })).toBeNull();
    expect(workerProblem(draft)).toBeNull();
  });

  it('sends only the fields that were filled in', () => {
    const draft = { ...emptyWorker('2026-01-01'), fullName: ' Ali ', tradeCode: 'mason' };
    expect(workerBody(draft)).toEqual({
      fullName: 'Ali',
      tradeCode: 'mason',
      employmentType: 'daily',
      joinedOn: '2026-01-01',
    });
    expect(
      workerBody({ ...draft, fatherName: ' Bashir ', cnic: ' 3520212345671 ', phone: ' 0300 ' }),
    ).toMatchObject({ fatherName: 'Bashir', cnic: '3520212345671', phone: '0300' });
  });

  it('checks the rate amount and date', () => {
    const draft = { ...emptyRate('2026-01-01'), amount: '1000' };
    expect(rateProblem({ ...draft, amount: '' })).toBe('amount');
    expect(rateProblem({ ...draft, amount: '0' })).toBe('amount');
    expect(rateProblem({ ...draft, amount: '1.234' })).toBe('amount');
    expect(rateProblem({ ...draft, effectiveFrom: '' })).toBe('date');
    expect(rateProblem(draft)).toBeNull();
    expect(rateBody({ ...draft, amount: ' 1000.50 ' })).toEqual({
      payBasis: 'daily_rate',
      amount: '1000.50',
      effectiveFrom: '2026-01-01',
    });
  });

  it('adds a moved worker once and knows today in Karachi', () => {
    const target = team('t2', 'TM-002', [member('w2', 'WK-0002', 'Other', 't2')]);
    expect(membersAfterMove(target, 'w1')).toEqual(['w2', 'w1']);
    expect(membersAfterMove(target, 'w2')).toEqual(['w2']);
    expect(karachiToday(new Date('2026-10-25T20:00:00Z'))).toBe('2026-10-26');
  });
});

describe('workers list and profile', () => {
  it('lists workers with the masked CNIC and filters by the search text', async () => {
    open('/workforce/workers');
    expect(await screen.findByText('Synthetic Worker')).toBeInTheDocument();
    expect(screen.getByText('*********4567')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'Syn{enter}');
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('text=Syn') && c.url.includes('status=active'))).toBe(
        true,
      ),
    );
  });

  it('creates a worker after the form is valid', async () => {
    open('/workforce/workers');
    await userEvent.click(await screen.findByRole('button', { name: 'New worker' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'New Person');
    await userEvent.type(within(dialog).getByLabelText('CNIC'), '123');
    expect(await within(dialog).findByText('A CNIC has 13 digits.')).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('CNIC'));
    await userEvent.type(within(dialog).getByLabelText('CNIC'), '35202-1234567-1');
    await userEvent.click(within(dialog).getByLabelText('Trade'));
    await userEvent.click(await screen.findByTitle('Mason'));
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(sent('POST', '/workforce/workers')).toBeDefined());
    expect(sent('POST', '/workforce/workers')?.body).toMatchObject({
      fullName: 'New Person',
      cnic: '35202-1234567-1',
      tradeCode: 'mason',
      employmentType: 'daily',
    });
  });

  it('shows an API problem inside the form', async () => {
    handler = (url, init) =>
      url === '/workforce/workers' && init.method === 'POST'
        ? { status: 409, body: { error: { code: 'cnic_in_use', message: 'x' } } }
        : url === '/workforce/trades'
          ? { body: [{ code: 'mason', name: 'Mason', version: 1 }] }
          : { body: page([]) };
    open('/workforce/workers');
    await userEvent.click(await screen.findByRole('button', { name: 'New worker' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Dup');
    await userEvent.click(within(dialog).getByLabelText('Trade'));
    await userEvent.click(await screen.findByTitle('Mason'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('An active worker already has this CNIC.')).toBeInTheDocument();
  });

  it('hides the new-worker button from someone who cannot manage workers', async () => {
    permissions = [workforcePermissions.workerRead];
    open('/workforce/workers');
    await screen.findByText('Synthetic Worker');
    expect(screen.queryByRole('button', { name: 'New worker' })).toBeNull();
  });

  it('shows the profile with the rate history, adds a rate and marks the worker as left', async () => {
    open('/workforce/workers/w1');
    expect(await screen.findByRole('heading', { level: 3 })).toHaveTextContent('Synthetic Worker');
    expect(await screen.findByText('1,000.00')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add rate' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Amount'), '1200');
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    await waitFor(() => expect(sent('POST', '/workforce/workers/w1/rates')).toBeDefined());
    expect(sent('POST', '/workforce/workers/w1/rates')?.body).toMatchObject({
      payBasis: 'daily_rate',
      amount: '1200',
    });
    expect(await screen.findByText('The rate is saved.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Left on'), { target: { value: '2026-02-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Mark as left' }));
    await waitFor(() => expect(sent('POST', '/workforce/workers/w1/deactivate')).toBeDefined());
    expect(sent('POST', '/workforce/workers/w1/deactivate')?.body).toEqual({
      leftOn: '2026-02-01',
      version: 2,
    });
    expect(await screen.findByText('The worker is marked as left.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as left' })).toBeNull();
  });

  it('does not ask for rates when the caller may not see pay (BR-7)', async () => {
    permissions = [workforcePermissions.workerRead];
    open('/workforce/workers/w1');
    await screen.findByRole('heading', { level: 3 });
    expect(screen.queryByText('Pay rates')).toBeNull();
    expect(calls.some((c) => c.url.includes('/rates'))).toBe(false);
  });

  it('reports a rejected deactivation', async () => {
    const original = handler;
    handler = (url, init) =>
      url === '/workforce/workers/w1/deactivate'
        ? {
            status: 422,
            body: { error: { code: 'unapproved_attendance', message: 'x' } },
          }
        : original(url, init);
    open('/workforce/workers/w1');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as left' }));
    expect(
      await screen.findByText('Approve the attendance sheets of this worker first.'),
    ).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/workforce/workers/w1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('team board', () => {
  it('moves a worker with the team chooser', async () => {
    open('/workforce/board');
    const first = await screen.findByTestId('team-TM-001');
    await within(first).findByText(/Synthetic Worker/);
    await userEvent.click(screen.getByLabelText('Move Synthetic Worker to another team'));
    await userEvent.click(await screen.findByTitle('TM-002 Team TM-002'));
    await waitFor(() => expect(sent('PUT', '/workforce/teams/t2/members')).toBeDefined());
    expect(sent('PUT', '/workforce/teams/t2/members')?.body).toMatchObject({
      workerIds: ['w2', 'w1'],
      version: 4,
    });
    expect(await screen.findByText('The team has been updated.')).toBeInTheDocument();
  });

  it('moves a worker that is dropped on another team and ignores a drop on its own team', async () => {
    open('/workforce/board');
    const from = await screen.findByTestId('team-TM-001');
    const to = await screen.findByTestId('team-TM-002');
    const card = await within(from).findByTestId('member-WK-0001');
    await within(to).findByTestId('member-WK-0002');
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? '',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(from, { dataTransfer });
    expect(sent('PUT', '/workforce/teams/t1/members')).toBeUndefined();
    fireEvent.drop(to, { dataTransfer });
    await waitFor(() => expect(sent('PUT', '/workforce/teams/t2/members')).toBeDefined());
    fireEvent.drop(to, { dataTransfer: { getData: () => '' } });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('does not move anything on an invalid date and shows a refused move', async () => {
    const original = handler;
    handler = (url, init) =>
      url === '/workforce/teams/t2/members'
        ? { status: 422, body: { error: { code: 'membership_overlap', message: 'x' } } }
        : original(url, init);
    open('/workforce/board');
    await screen.findByTestId('member-WK-0001');
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '' } });
    await userEvent.click(screen.getByLabelText('Move Synthetic Worker to another team'));
    await userEvent.click(
      (await screen.findAllByTitle('TM-002 Team TM-002')).at(-1) as HTMLElement,
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-10-25' } });
    await userEvent.click(screen.getByLabelText('Move Synthetic Worker to another team'));
    await userEvent.click(
      (await screen.findAllByTitle('TM-002 Team TM-002')).at(-1) as HTMLElement,
    );
    expect(
      await screen.findByText('The worker is already in a team on these dates.'),
    ).toBeInTheDocument();
  });

  it('says so when there are no teams, and when loading fails', async () => {
    handler = (url) => (url === '/workforce/teams' ? { body: [] } : undefined);
    const view = open('/workforce/board');
    expect(await screen.findByText('There are no active teams.')).toBeInTheDocument();
    view.unmount();
    handler = () => ({ status: 500, body: {} });
    open('/workforce/board');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });

  it('is closed to someone who cannot manage teams', async () => {
    permissions = [workforcePermissions.workerRead];
    open('/workforce/board');
    await waitFor(() => expect(screen.queryByText('Team board', { selector: 'h3' })).toBeNull());
    expect(calls.some((c) => c.url.startsWith('/workforce/teams'))).toBe(false);
  });
});

describe('supervisor team view', () => {
  it('lists the own teams with members and no pay', async () => {
    permissions = [workforcePermissions.workerRead];
    open('/workforce/my-teams');
    expect(await screen.findByText('TM-001 Team TM-001')).toBeInTheDocument();
    expect(screen.getByText(/WK-0001 Synthetic Worker \(Mason\)/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('rate'))).toBe(false);
  });

  it('says so when the caller supervises no team, and when loading fails', async () => {
    handler = (url) => (url === '/workforce/teams/mine' ? { body: [] } : undefined);
    const view = open('/workforce/my-teams');
    expect(await screen.findByText('You supervise no team.')).toBeInTheDocument();
    view.unmount();
    handler = () => ({ status: 500, body: {} });
    open('/workforce/my-teams');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
