import { crmPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { StageChangeDialog } from './StageChangeDialog';
import type { CrmReference, Lead } from './api';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init: RequestInit) => Reply | undefined;
let handler: Handler;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const reference: CrmReference = {
  stages: [
    { code: 'new', name: 'New', sortOrder: 1, kind: 'open', active: true },
    { code: 'quoted', name: 'Quoted', sortOrder: 2, kind: 'open', active: true },
    { code: 'won', name: 'Won', sortOrder: 3, kind: 'won', active: true },
    { code: 'lost', name: 'Lost', sortOrder: 4, kind: 'lost', active: true },
  ],
  sources: [{ code: 'referral', name: 'Referral' }],
  lossReasons: [{ code: 'price', name: 'Price too high' }],
};

const lead: Lead = {
  id: 'l1',
  number: 'LEAD-0001',
  partyId: null,
  contactName: 'Bilal Ahmed',
  contactPhone: '+923001234567',
  workType: 'renovation',
  sector: 'private',
  locationId: null,
  siteAddress: 'F-10, Islamabad',
  description: null,
  expectedValue: '2500000.00',
  sourceCode: 'referral',
  stageCode: 'new',
  stageKind: 'open',
  ownerUserId: 'u1',
  lossReasonCode: null,
  wonAt: null,
  lostAt: null,
  hasOverdueFollowUp: true,
  version: 3,
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url) => {
    if (url.startsWith('/crm/reference')) return { body: reference };
    if (url.startsWith('/crm/leads/l1')) {
      return {
        body: {
          lead,
          visits: [
            {
              id: 'v1',
              leadId: 'l1',
              visitDate: '2026-10-20',
              visitedBy: 'u1',
              notes: 'Measured',
              version: 1,
            },
          ],
          followUps: [
            {
              id: 'f1',
              leadId: 'l1',
              leadNumber: 'LEAD-0001',
              dueDate: '2026-10-22',
              note: 'Call back',
              assignedTo: 'u1',
              status: 'open',
              doneAt: null,
              overdue: true,
              version: 2,
            },
          ],
          history: [
            { fromStage: null, toStage: 'new', at: '2026-10-18T05:00:00.000Z', by: 'u1' },
            { fromStage: 'new', toStage: 'quoted', at: '2026-10-19T05:00:00.000Z', by: 'u1' },
          ],
        },
      };
    }
    if (url.startsWith('/crm/leads')) return { body: page([lead]) };
    if (url.startsWith('/crm/follow-ups')) {
      return {
        body: page([
          {
            id: 'f1',
            leadId: 'l1',
            leadNumber: 'LEAD-0001',
            dueDate: '2026-10-22',
            note: 'Call back',
            assignedTo: 'u1',
            status: 'open',
            doneAt: null,
            overdue: true,
            version: 2,
          },
        ]),
      };
    }
    if (url.startsWith('/files')) return { body: { items: [] } };
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
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
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
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

describe('stage change dialog (T-6)', () => {
  const renderDialog = (overrides: Partial<Lead> = {}) => {
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <AppProviders auth={fakeAuth()}>
        <StageChangeDialog
          open
          lead={{ ...lead, ...overrides }}
          reference={reference}
          onClose={onClose}
          onMoved={onMoved}
        />
      </AppProviders>,
    );
    return { onClose, onMoved };
  };

  const choose = async (label: string, option: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: label }));
    await userEvent.click(await screen.findByTitle(option));
  };

  it('asks for a stage before moving', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Choose a stage.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('asks for a loss reason only for a lost stage and sends it', async () => {
    handler = () => ({ body: { ...lead, stageCode: 'lost', stageKind: 'lost' } });
    const { onClose, onMoved } = renderDialog();
    expect(screen.queryByRole('combobox', { name: 'Loss reason' })).not.toBeInTheDocument();

    await choose('Move to stage', 'Lost');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Choose why the lead was lost.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await choose('Loss reason', 'Price too high');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: '/crm/leads/l1/stage',
      method: 'POST',
      body: { stageCode: 'lost', lossReasonCode: 'price', version: 3 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not offer the current stage and tells that a client is created on a win', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('combobox', { name: 'Move to stage' }));
    expect(screen.queryByTitle('New')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTitle('Won'));
    expect(
      screen.getByText('A client will be created from the contact details of this lead.'),
    ).toBeInTheDocument();
  });

  it('shows the answer of the API when the move is refused', async () => {
    handler = () => ({
      status: 422,
      body: { error: { code: 'lead_closed', message: 'closed' } },
    });
    renderDialog();
    await choose('Move to stage', 'Quoted');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(
      await screen.findByText(
        'A won or lost lead can only change its notes, or be reopened by a manager.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a general message when the request fails without an answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    renderDialog();
    await choose('Move to stage', 'Quoted');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });
});

describe('leads page', () => {
  it('lists leads with the overdue flag and filters by stage and text', async () => {
    open('/crm/leads');
    expect(await screen.findByRole('link', { name: 'LEAD-0001' })).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('2,500,000.00')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'bilal{enter}');
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=bilal'))).toBe(true));

    await userEvent.click(screen.getByLabelText('Overdue follow-ups only'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('overdue=true'))).toBe(true));
  });

  it('shows the board with a column per stage and changes the stage from a card', async () => {
    open('/crm/leads');
    await screen.findByRole('link', { name: 'LEAD-0001' });
    await userEvent.click(screen.getByText('Board'));
    const column = await screen.findByTestId('stage-new');
    expect(within(column).getByRole('link', { name: 'LEAD-0001' })).toBeInTheDocument();
    expect(within(screen.getByTestId('stage-won')).queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(within(column).getByRole('button', { name: 'Change stage LEAD-0001' }));
    expect(await screen.findByText('Change stage of LEAD-0001')).toBeInTheDocument();
  });

  it('creates a lead with the contact details', async () => {
    const base = handler;
    handler = (url, init) =>
      init.method === 'POST' ? { status: 201, body: lead } : base(url, init);
    open('/crm/leads');
    await userEvent.click(await screen.findByRole('button', { name: 'New lead' }));
    await userEvent.type(await screen.findByLabelText('Contact name'), 'Sara Khan');
    await userEvent.type(screen.getByLabelText('Contact phone'), '0300 1234567');
    await userEvent.click(screen.getByRole('combobox', { name: 'Source' }));
    await userEvent.click(await screen.findByTitle('Referral'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        contactName: 'Sara Khan',
        contactPhone: '0300 1234567',
        workType: 'new_build',
        sector: 'private',
        sourceCode: 'referral',
      }),
    );
  });

  it('validates the lead form before sending', async () => {
    open('/crm/leads');
    await userEvent.click(await screen.findByRole('button', { name: 'New lead' }));
    await userEvent.type(await screen.findByLabelText('Contact phone'), 'abc');
    await userEvent.type(screen.getByLabelText('Expected value (PKR)'), '1.234');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('This field is required')).not.toHaveLength(0);
    expect(screen.getByText('Enter an amount with at most two decimals')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('hides creation without the permission', async () => {
    permissions = [crmPermissions.leadRead];
    open('/crm/leads');
    await screen.findByRole('link', { name: 'LEAD-0001' });
    expect(screen.queryByRole('button', { name: 'New lead' })).not.toBeInTheDocument();
  });

  it('shows 403 without the read permission (BR-9)', async () => {
    permissions = [];
    open('/crm/leads');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    handler = (url) =>
      url.startsWith('/crm/reference') ? { body: reference } : { status: 500, body: {} };
    open('/crm/leads');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('lead detail page', () => {
  it('shows the timeline, visits and follow-ups and completes a follow-up', async () => {
    open('/crm/leads/l1');
    expect(await screen.findByText(/Moved from New to Quoted/)).toBeInTheDocument();
    expect(screen.getByText(/Lead created in New/)).toBeInTheDocument();
    expect(screen.getByText('Measured')).toBeInTheDocument();
    expect(screen.getByText(/Call back/)).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/crm/follow-ups/f1/done')).toMatchObject({
        method: 'POST',
        body: { version: 2 },
      }),
    );
  });

  it('adds a visit and a follow-up', async () => {
    open('/crm/leads/l1');
    await screen.findByText('Measured');
    await userEvent.type(screen.getByLabelText('Visit date'), '2026-10-24');
    await userEvent.click(screen.getByRole('button', { name: 'Add visit' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/crm/leads/l1/visits')?.body).toMatchObject({
        visitDate: '2026-10-24',
      }),
    );
    await userEvent.type(screen.getByLabelText('Due date'), '2026-11-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add follow-up' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/crm/leads/l1/follow-ups')?.body).toMatchObject({
        dueDate: '2026-11-01',
      }),
    );
  });

  it('shows the API answer when adding a visit fails and rejects a bad date locally', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/crm/leads/l1/visits'
        ? { status: 422, body: { error: { code: 'visit_in_future', message: 'future' } } }
        : base(url, init);
    open('/crm/leads/l1');
    await screen.findByText('Measured');
    await userEvent.type(screen.getByLabelText('Visit date'), '24/10/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Add visit' }));
    expect(await screen.findByText('Use the format yyyy-mm-dd')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Visit date'));
    await userEvent.type(screen.getByLabelText('Visit date'), '2030-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add visit' }));
    expect(
      await screen.findByText('A site visit cannot be dated in the future.'),
    ).toBeInTheDocument();
  });

  it('opens the edit form and the stage dialog', async () => {
    open('/crm/leads/l1');
    await screen.findByText('Measured');
    await userEvent.click(screen.getByRole('button', { name: 'Edit lead' }));
    expect(await screen.findByLabelText('Contact name')).toHaveValue('Bilal Ahmed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
        contactName: 'Bilal Ahmed',
        version: 3,
      }),
    );
  });

  it('hides actions for read-only users (accountant)', async () => {
    permissions = [crmPermissions.leadRead];
    open('/crm/leads/l1');
    await screen.findByText('Measured');
    expect(screen.queryByRole('button', { name: 'Edit lead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add visit' })).not.toBeInTheDocument();
  });

  it('shows the closed lead notice and no add forms for a closed lead', async () => {
    const base = handler;
    handler = (url, init) => {
      const reply = base(url, init);
      if (url === '/crm/leads/l1') {
        const body = reply?.body as { lead: Lead };
        return {
          body: {
            ...body,
            lead: { ...lead, stageCode: 'lost', stageKind: 'lost', lossReasonCode: 'price' },
          },
        };
      }
      return reply;
    };
    open('/crm/leads/l1');
    expect(await screen.findByText('Price too high')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add visit' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit lead' }));
    expect(
      await screen.findByText('This lead is closed. Only the notes can change.'),
    ).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    handler = (url) =>
      url.startsWith('/crm/reference') ? { body: reference } : { status: 404, body: {} };
    open('/crm/leads/l1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('follow-ups page', () => {
  it('lists open follow-ups with the overdue flag and completes one', async () => {
    open('/crm/follow-ups');
    expect(await screen.findByText('Call back')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(calls.find((c) => c.url.startsWith('/crm/follow-ups'))?.url).toContain('status=open');
    await userEvent.click(screen.getByRole('button', { name: 'Mark done LEAD-0001' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/crm/follow-ups/f1/done')?.body).toEqual({ version: 2 }),
    );
  });

  it('switches the status filter and shows failures', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/crm/follow-ups/f1/done'
        ? { status: 409, body: { error: { code: 'version_conflict', message: 'conflict' } } }
        : base(url, init);
    open('/crm/follow-ups');
    await screen.findByText('Call back');
    await userEvent.click(screen.getByRole('button', { name: 'Mark done LEAD-0001' }));
    expect(
      await screen.findByText('Someone else changed this lead. Reload and try again.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByTitle('Done'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=done'))).toBe(true));
  });

  it('hides the done button without the follow-up permission', async () => {
    permissions = [crmPermissions.leadRead];
    open('/crm/follow-ups');
    await screen.findByText('Call back');
    expect(screen.queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/crm/follow-ups');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
