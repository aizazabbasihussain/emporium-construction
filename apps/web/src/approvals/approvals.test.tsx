import { approvalsPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

interface Call {
  url: string;
  method: string;
  body: unknown;
}
type Handler = (call: Call) => { status?: number; body?: unknown };

let handler: Handler;
let permissions: string[];
const calls: Call[] = [];

const step = (stepNo: number, roleCode: string) => ({ stepNo, roleCode, minApprovers: 1 });
const pending = (over: object = {}) => ({
  id: 'r1',
  docType: 'purchase_order',
  docId: 'd1',
  revision: 1,
  amount: '250000.00',
  requesterId: 'u9',
  status: 'pending',
  currentStep: 2,
  currentRole: 'management',
  submittedAt: '2026-10-24T10:00:00.000Z',
  version: 3,
  steps: [step(1, 'project_manager'), step(2, 'management')],
  actions: [
    { stepNo: 1, actorId: 'u3', action: 'approve', comment: 'checked quantities', at: 'x' },
    { stepNo: 1, actorId: 'u4', action: 'approve', comment: null, at: 'y' },
  ],
  ...over,
});
const ruleSet = {
  effectiveFrom: '2026-01-01',
  bands: [
    { minAmount: '0.00', maxAmount: '1000.00', steps: [step(1, 'project_manager')] },
    { minAmount: '1000.00', maxAmount: null, steps: [step(1, 'management')] },
  ],
};

const failNetwork = (): never => {
  throw new Error('network down');
};

const defaults: Handler = ({ url }) => {
  if (url === '/approvals/inbox') return { body: { items: [pending()] } };
  if (url === '/admin/approval-rules') return { body: { items: ['expense', 'purchase_order'] } };
  if (url.startsWith('/admin/approval-rules/')) {
    return { body: { docType: 'purchase_order', sets: [ruleSet] } };
  }
  return { body: pending({ status: 'approved' }) };
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = defaults;
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions)),
        });
      }
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(call);
      const { status = 200, body = {} } = handler(call);
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

const openRequest = async () => {
  open('/approvals');
  await userEvent.click(await screen.findByRole('button', { name: /Open purchase_order/ }));
};

describe('approvals inbox', () => {
  it('lists pending requests with their current step', async () => {
    open('/approvals');
    expect(await screen.findByText('purchase_order #1')).toBeInTheDocument();
    expect(screen.getByText('250,000.00')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2: management')).toBeInTheDocument();
  });

  it('shows an empty message and a load error', async () => {
    handler = ({ url }) => (url === '/approvals/inbox' ? { body: { items: [] } } : {});
    open('/approvals');
    expect(await screen.findByText('Nothing is waiting for your approval.')).toBeInTheDocument();
  });

  it('shows the history and approves with the current version', async () => {
    await openRequest();
    expect(
      screen.getByText(/Approved — Step 1 of 2: project_manager: checked quantities/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Your decision was recorded.')).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/approvals/requests/r1/approve');
    expect(post?.body).toEqual({ comment: null, version: 3 });
  });

  it('needs a comment to reject or return, then sends it', async () => {
    await openRequest();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(screen.getByText('A comment is required to reject or return')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Comment'), '  over budget ');
    await userEvent.click(screen.getByRole('button', { name: 'Return' }));
    await screen.findByText('Your decision was recorded.');
    expect(calls.find((c) => c.url.endsWith('/return'))?.body).toEqual({
      comment: 'over budget',
      version: 3,
    });
  });

  it('shows the reason when the server refuses', async () => {
    handler = (call) =>
      call.method === 'POST'
        ? { status: 403, body: { error: { code: 'self_approval', message: 'x' } } }
        : defaults(call);
    await openRequest();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('You cannot act on your own request.')).toBeInTheDocument();
  });

  it('shows a generic message for unexpected failures', async () => {
    handler = (call) => (call.method === 'POST' ? failNetwork() : defaults(call));
    await openRequest();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('blocks people without the inbox permission', async () => {
    permissions = [];
    open('/approvals');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('approval rules editor', () => {
  const choose = async () => {
    open('/admin/approval-rules');
    await userEvent.click(await screen.findByRole('combobox', { name: 'Document type' }));
    await userEvent.click(await screen.findByTitle('purchase_order'));
  };

  it('loads the rule set in force and saves edits', async () => {
    await choose();
    expect(await screen.findByLabelText('Effective from')).toHaveValue('2026-01-01');
    const role = screen.getByLabelText('Role 2.1');
    await userEvent.clear(role);
    await userEvent.type(role, 'accountant');
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Rules saved.')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/admin/approval-rules/purchase_order');
    expect(put?.body).toMatchObject({
      effectiveFrom: '2026-01-01',
      bands: [{}, { steps: [{ roleCode: 'accountant' }] }],
    });
  });

  it('adds and removes bands and steps', async () => {
    await choose();
    await screen.findByLabelText('Effective from');
    await userEvent.click(screen.getByRole('button', { name: 'Add amount band' }));
    expect(screen.getByLabelText('From amount (inclusive) 3')).toHaveValue('0');
    await userEvent.click(screen.getByRole('button', { name: 'Remove band 3' }));
    expect(screen.queryByLabelText('From amount (inclusive) 3')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add step 1' }));
    const second = screen.getByLabelText('Role 1.2');
    await userEvent.type(second, 'management');
    await userEvent.clear(screen.getByLabelText('Approvers needed 1.2'));
    await userEvent.type(screen.getByLabelText('Approvers needed 1.2'), '2');
    await userEvent.type(
      screen.getByLabelText('Up to amount (exclusive, empty for no limit) 2'),
      '9',
    );
    await userEvent.clear(screen.getByLabelText('Up to amount (exclusive, empty for no limit) 2'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 1.1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')?.body as {
      bands: {
        maxAmount: string | null;
        steps: { stepNo: number; roleCode: string; minApprovers: number }[];
      }[];
    };
    expect(body.bands[0]?.steps).toEqual([{ stepNo: 1, roleCode: 'management', minApprovers: 2 }]);
    expect(body.bands[1]?.maxAmount).toBeNull();
  });

  it('starts a blank rule for a document type without rules', async () => {
    handler = (call) =>
      call.url === '/admin/approval-rules/purchase_order'
        ? { body: { docType: 'purchase_order', sets: [] } }
        : defaults(call);
    await choose();
    expect(await screen.findByLabelText('From amount (inclusive) 1')).toHaveValue('0');
  });

  it('prefers the set in force over one that starts later', async () => {
    handler = (call) =>
      call.url === '/admin/approval-rules/purchase_order'
        ? {
            body: {
              docType: 'purchase_order',
              sets: [ruleSet, { ...ruleSet, effectiveFrom: '2999-01-01' }],
            },
          }
        : defaults(call);
    await choose();
    expect(await screen.findByLabelText('Effective from')).toHaveValue('2026-01-01');
  });

  it('shows validation errors from the server', async () => {
    handler = (call) =>
      call.method === 'PUT'
        ? { status: 400, body: { error: { code: 'band_overlap', message: 'x' } } }
        : defaults(call);
    await choose();
    await screen.findByLabelText('Effective from');
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Amount bands overlap.')).toBeInTheDocument();
  });

  it('shows a generic message for unexpected failures', async () => {
    handler = (call) => (call.method === 'PUT' ? failNetwork() : defaults(call));
    await choose();
    await screen.findByLabelText('Effective from');
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('needs the rule manage permission', async () => {
    permissions = allPermissions.filter((p) => p !== approvalsPermissions.ruleManage);
    open('/admin/approval-rules');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});
