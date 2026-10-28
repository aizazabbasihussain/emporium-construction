/* eslint-disable @typescript-eslint/no-explicit-any --
   These tests read untyped JSON bodies of the HTTP API. */
import { inventoryPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { emptySheetLine, sheetProblem } from './SheetLines';

type Reply = { status?: number; body: unknown };
let permissions: string[];
let refuse: Reply | undefined;
let defaultCostCodeId: string | null;
const calls: { url: string; method: string; body: Record<string, any> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const transfer = (status: string, version = 1) => ({
  id: 't1',
  number: 'STR-2026-0001',
  fromStoreId: 's1',
  toStoreId: 's2',
  status,
  businessDate: '2026-10-25',
  version,
  lines: [{ id: 'tl1', itemId: 'i1', ownership: 'company', quantity: '5.0000' }],
});

let transferStatus = 'draft';
let countStatus = 'draft';

beforeEach(() => {
  calls.length = 0;
  refuse = undefined;
  permissions = allPermissions;
  defaultCostCodeId = 'cc1';
  transferStatus = 'draft';
  countStatus = 'draft';
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
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const reply = (): Reply => {
        if (method !== 'GET' && refuse !== undefined) return refuse;
        if (url.startsWith('/master/items')) {
          return {
            body: page([
              { id: 'i1', code: 'CEM', name: 'Cement', stockable: true, defaultCostCodeId },
              { id: 'i2', code: 'PAINT', name: 'Paint', stockable: false, defaultCostCodeId: null },
            ]),
          };
        }
        if (url.startsWith('/master/cost-codes')) {
          return { body: page([{ id: 'cc1', code: '100', name: 'Materials' }]) };
        }
        if (url.startsWith('/master/parties')) {
          return { body: page([{ id: 'c1', name: 'Hassan Builders' }]) };
        }
        if (url.startsWith('/projects?')) {
          return { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) };
        }
        if (url.startsWith('/inventory/stores')) {
          return {
            body: page([
              { id: 's1', code: 'WH-1', name: 'Main warehouse', active: true },
              { id: 's2', code: 'SITE-1', name: 'Site store', active: true },
              { id: 's3', code: 'OLD', name: 'Closed store', active: false },
            ]),
          };
        }
        if (url.startsWith('/inventory/stock')) {
          return {
            body: page([
              {
                storeId: 's1',
                itemId: 'i1',
                ownership: 'company',
                ownerPartyId: null,
                quantity: '25.0000',
              },
              {
                storeId: 's2',
                itemId: 'i1',
                ownership: 'client',
                ownerPartyId: 'c1',
                quantity: '4.0000',
              },
            ]),
          };
        }
        if (url.startsWith('/inventory/ledger')) {
          return {
            body: page([
              {
                id: 'l1',
                seq: 1,
                storeId: 's1',
                itemId: 'i1',
                ownership: 'company',
                movementType: 'receipt',
                quantity: '25.0000',
                unitCost: '10.0000',
                value: '250.00',
                sourceDocType: 'grn',
                businessDate: '2026-10-25',
              },
              {
                id: 'l2',
                seq: 2,
                storeId: 's2',
                itemId: 'i1',
                ownership: 'client',
                movementType: 'client_receipt',
                quantity: '4.0000',
                unitCost: null,
                value: null,
                sourceDocType: 'client_receipt',
                businessDate: '2026-10-25',
              },
            ]),
          };
        }
        if (url === '/inventory/issues') {
          return {
            status: 201,
            body: { id: 'is1', quantity: '3.0000', value: '30.00', costEntryId: 'e1' },
          };
        }
        if (url.startsWith('/inventory/client-material/')) {
          return {
            body: [
              {
                storeId: 's2',
                itemId: 'i1',
                received: '10.0000',
                used: '4.0000',
                returned: '2.0000',
                balance: '4.0000',
              },
            ],
          };
        }
        if (url === '/inventory/transfers' && method === 'POST') {
          return { status: 201, body: transfer('draft') };
        }
        if (url.startsWith('/inventory/transfers/t1/')) return { body: transfer('in_transit', 2) };
        if (url.startsWith('/inventory/transfers'))
          return { body: page([transfer(transferStatus)]) };
        if (url === '/inventory/counts' && method === 'POST') {
          return { status: 201, body: { id: 'k1', number: 'CNT-2026-0001', status: 'draft' } };
        }
        if (url.startsWith('/inventory/counts/k1/')) return { body: { id: 'k1' } };
        if (url.startsWith('/inventory/counts')) {
          return {
            body: page([
              {
                id: 'k1',
                number: 'CNT-2026-0001',
                storeId: 's1',
                status: countStatus,
                countedOn: '2026-10-25',
                version: 1,
                lines: [{ id: 'kl1', itemId: 'i1', systemQty: '25.0000', countedQty: '23.0000' }],
              },
            ]),
          };
        }
        return { body: page([]) };
      };
      const { status = 200, body } = reply();
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

const pick = async (label: string, option: string) => {
  await userEvent.click(screen.getByLabelText(label));
  const options = await screen.findAllByText(option, {
    selector: '.ant-select-item-option-content',
  });
  await userEvent.click(options[options.length - 1] as HTMLElement);
};

const written = () => calls.filter((c) => c.method !== 'GET');

describe('sheet lines', () => {
  it('names the first problem of a sheet', () => {
    expect(sheetProblem([])).toBe('inventory.validation.noLines');
    expect(sheetProblem([emptySheetLine()])).toBe('inventory.validation.item');
    expect(sheetProblem([{ itemId: 'i1', quantity: 'x' }])).toBe('inventory.validation.quantity');
    expect(sheetProblem([{ itemId: 'i1', quantity: '2.5' }])).toBeNull();
  });
});

describe('issue form (T-11)', () => {
  it('checks the form, shows the default cost code and posts the issue', async () => {
    open('/inventory/issue');
    await screen.findByRole('heading', { name: 'Issue material' });
    const submit = screen.getByRole('button', { name: 'Issue' });
    await userEvent.click(submit);
    expect(screen.getByText('Choose the store, the item and the project.')).toBeVisible();

    await pick('Store', 'WH-1 Main warehouse');
    await pick('Item', 'CEM Cement');
    await pick('Project', 'PRJ-0001 Boundary wall');
    await userEvent.type(screen.getByLabelText('Quantity'), '0');
    await userEvent.click(submit);
    expect(
      screen.getByText('Enter a quantity above zero with at most four decimals.'),
    ).toBeVisible();
    expect(screen.getByText('Default cost code of the item: 100 Materials')).toBeVisible();

    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.click(submit);
    expect(
      await screen.findByText('Issued 3.0000; cost 30.00 posted to the project.'),
    ).toBeVisible();
    const sent = written()[0];
    expect(sent?.url).toBe('/inventory/issues');
    expect(sent?.body).toMatchObject({
      storeId: 's1',
      itemId: 'i1',
      quantity: '3',
      costObject: { type: 'project', id: 'p1' },
    });
    expect(sent?.body).not.toHaveProperty('costCodeId');
  });

  it('needs a cost code when the item has no default', async () => {
    defaultCostCodeId = null;
    open('/inventory/issue');
    await screen.findByRole('heading', { name: 'Issue material' });
    await pick('Store', 'WH-1 Main warehouse');
    await pick('Item', 'CEM Cement');
    await pick('Project', 'PRJ-0001 Boundary wall');
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(
      screen.getByText('Choose a cost code: this item has no default cost code.'),
    ).toBeVisible();
    await pick('Cost code', '100 Materials');
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await screen.findByText(/Issued 3.0000/);
    expect(written()[0]?.body).toMatchObject({ costCodeId: 'cc1' });
  });

  it('issues client-owned material with its owner and no cost code', async () => {
    open('/inventory/issue');
    await screen.findByRole('heading', { name: 'Issue material' });
    await pick('Store', 'WH-1 Main warehouse');
    await pick('Item', 'CEM Cement');
    await pick('Project', 'PRJ-0001 Boundary wall');
    await userEvent.type(screen.getByLabelText('Quantity'), '2');
    await userEvent.click(screen.getByLabelText('Client-owned material (no cost is posted)'));
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(screen.getByText('Choose the client who owns the material.')).toBeVisible();
    await pick('Client owner', 'Hassan Builders');
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await screen.findByText(/Issued 3.0000/);
    expect(written()[0]?.body).toMatchObject({ ownership: 'client', ownerPartyId: 'c1' });
    expect(written()[0]?.body).not.toHaveProperty('costCodeId');
  });

  it('shows the explanation when the API refuses', async () => {
    refuse = {
      status: 422,
      body: { error: { code: 'insufficient_stock', message: 'Short by 2' } },
    };
    open('/inventory/issue');
    await screen.findByRole('heading', { name: 'Issue material' });
    await pick('Store', 'WH-1 Main warehouse');
    await pick('Item', 'CEM Cement');
    await pick('Project', 'PRJ-0001 Boundary wall');
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await screen.findByText('There is not enough stock for this movement.')).toBeVisible();
    refuse = { status: 500, body: { oops: true } };
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await screen.findByText('Request failed')).toBeVisible();
  });

  it('offers only stockable items and active stores', async () => {
    open('/inventory/issue');
    await screen.findByRole('heading', { name: 'Issue material' });
    await userEvent.click(screen.getByLabelText('Item'));
    expect(
      await screen.findByText('CEM Cement', { selector: '.ant-select-item-option-content' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('PAINT Paint')).toBeNull();
    await userEvent.click(screen.getByLabelText('Store'));
    await screen.findByText('WH-1 Main warehouse', { selector: '.ant-select-item-option-content' });
    expect(screen.queryByText('OLD Closed store')).toBeNull();
  });
});

describe('stock, ledger and client material screens', () => {
  it('lists stock with company and client rows and filters by store', async () => {
    open('/inventory/stock');
    expect(await screen.findByText('25.0000')).toBeVisible();
    expect(screen.getAllByText('Client').length).toBeGreaterThan(0);
    await pick('Store', 'WH-1 Main warehouse');
    await waitFor(() => expect(calls.some((c) => c.url.includes('storeId=s1'))).toBe(true));
    expect(
      screen
        .getAllByRole('link', { name: 'Issue material' })
        .every((link) => link.getAttribute('href') === '/inventory/issue'),
    ).toBe(true);
  });

  it('shows the ledger and filters by movement', async () => {
    open('/inventory/ledger');
    expect(await screen.findByText('250.00')).toBeVisible();
    expect(screen.getByText('Client material received')).toBeVisible();
    await pick('Movement', 'Issue');
    await waitFor(() => expect(calls.some((c) => c.url.includes('movementType=issue'))).toBe(true));
  });

  it('reconciles the client material of a project', async () => {
    open('/inventory/client-material');
    await screen.findByRole('heading', { name: 'Client material' });
    expect(calls.some((c) => c.url.startsWith('/inventory/client-material/'))).toBe(false);
    await pick('Project', 'PRJ-0001 Boundary wall');
    const row = (await screen.findByText('10.0000')).closest('tr') as HTMLElement;
    expect(within(row).getAllByText('4.0000')).toHaveLength(2);
    expect(within(row).getByText('2.0000')).toBeVisible();
  });
});

describe('transfers and counts screens', () => {
  it('creates a transfer and moves it through send and receive', async () => {
    open('/inventory/transfers');
    await screen.findByRole('heading', { name: 'Stock transfers' });
    await userEvent.click(screen.getByRole('button', { name: 'Create transfer' }));
    expect(screen.getByText('Choose the two stores.')).toBeVisible();
    await pick('From store', 'WH-1 Main warehouse');
    await pick('To store', 'SITE-1 Site store');
    await userEvent.click(screen.getByRole('button', { name: 'Create transfer' }));
    expect(screen.getByText('Choose an item on every line.')).toBeVisible();
    await pick('Item 1', 'CEM Cement');
    await userEvent.type(screen.getByLabelText('Quantity 1'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Create transfer' }));
    await waitFor(() => expect(written()[0]?.url).toBe('/inventory/transfers'));
    expect(written()[0]?.body).toMatchObject({
      fromStoreId: 's1',
      toStoreId: 's2',
      lines: [{ itemId: 'i1', quantity: '5' }],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(written().at(-1)?.url).toBe('/inventory/transfers/t1/send'));
    expect(written().at(-1)?.body).toEqual({ version: 1 });
  });

  it('shows receive and cancel for an in-transit transfer and nothing once received', async () => {
    transferStatus = 'in_transit';
    const first = open('/inventory/transfers');
    await userEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    await waitFor(() => expect(written().at(-1)?.url).toBe('/inventory/transfers/t1/receive'));
    first.unmount();
    transferStatus = 'received';
    open('/inventory/transfers');
    await screen.findByText('STR-2026-0001');
    expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows a refusal of a transfer action', async () => {
    refuse = { status: 422, body: { error: { code: 'insufficient_stock', message: 'Short' } } };
    open('/inventory/transfers');
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('There is not enough stock for this movement.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(written().at(-1)?.url).toBe('/inventory/transfers/t1/cancel'));
  });

  it('hides the transfer form from a user who cannot transfer', async () => {
    permissions = [inventoryPermissions.stockRead];
    open('/inventory/transfers');
    await screen.findByText('STR-2026-0001');
    expect(screen.queryByRole('button', { name: 'Create transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('saves a count sheet, submits it for approval and can cancel it', async () => {
    open('/inventory/counts');
    await screen.findByRole('heading', { name: 'Stock counts' });
    await userEvent.click(screen.getByRole('button', { name: 'Save count sheet' }));
    expect(screen.getByText('Choose the store.')).toBeVisible();
    await pick('Store', 'WH-1 Main warehouse');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save count sheet' }));
    expect(screen.getByText('Add at least one line.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await pick('Item 1', 'CEM Cement');
    await userEvent.type(screen.getByLabelText('Counted quantity 1'), '23');
    await userEvent.click(screen.getByRole('button', { name: 'Save count sheet' }));
    await waitFor(() => expect(written()[0]?.url).toBe('/inventory/counts'));
    expect(written()[0]?.body).toMatchObject({
      storeId: 's1',
      lines: [{ itemId: 'i1', countedQty: '23' }],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(written().at(-1)?.url).toBe('/inventory/counts/k1/submit'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(written().at(-1)?.url).toBe('/inventory/counts/k1/cancel'));
  });

  it('shows the books next to the count and the refusal when the loss cost code is missing', async () => {
    refuse = {
      status: 422,
      body: { error: { code: 'stock_loss_cost_code_missing', message: 'Set the setting' } },
    };
    open('/inventory/counts');
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(
      await screen.findByText('Stock counts cannot be submitted until the loss cost code is set.'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(await screen.findByText(/Cement.*25.0000.*23.0000/)).toBeVisible();
  });

  it('shows an approved count without actions', async () => {
    countStatus = 'approved';
    open('/inventory/counts');
    await screen.findByText('CNT-2026-0001');
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.getByText('Approved')).toBeVisible();
  });

  it('shows only the cancel action for a count waiting for approval', async () => {
    countStatus = 'counted';
    open('/inventory/counts');
    await screen.findByText('Waiting for approval');
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Cancel' }).length).toBeGreaterThan(0);
  });
});
