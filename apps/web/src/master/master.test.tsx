import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init: RequestInit) => Reply | undefined;
let handler: Handler;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
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

const party = {
  id: 'p1',
  code: 'VN-0001',
  name: 'Al Noor Traders',
  legalName: null,
  roles: ['vendor', 'subcontractor'],
  ntn: null,
  strn: null,
  cnic: null,
  phone: '+923001234567',
  email: null,
  address: null,
  city: 'Lahore',
  status: 'active',
  notes: null,
  version: 3,
};

const written = () => calls.filter((c) => c.method !== 'GET');

describe('parties page', () => {
  beforeEach(() => {
    handler = (url, init) => {
      if (url.startsWith('/master/parties/check-duplicate')) return { body: { duplicates: [] } };
      if (init.method === 'POST' || init.method === 'PUT') return { body: party };
      if (url.startsWith('/master/parties')) return { body: page([party]) };
      return undefined;
    };
  });

  it('lists parties with their roles and searches by text (AC-1)', async () => {
    open('/master/parties');
    expect(await screen.findByText('Al Noor Traders')).toBeInTheDocument();
    expect(screen.getByText('Vendor, Subcontractor')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Search'), '35202{enter}');
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=35202'))).toBe(true));
  });

  it('validates the form: name, roles, CNIC and phone', async () => {
    open('/master/parties');
    await screen.findByText('Al Noor Traders');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('CNIC'), '1234');
    await userEvent.type(screen.getByLabelText('Phone'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter 13 digits')).toBeInTheDocument();
    expect(screen.getByText('Enter a Pakistan number such as 0300 1234567')).toBeInTheDocument();
    expect(screen.getByText('This field is required')).toBeInTheDocument();
    expect(written()).toEqual([]);
  });

  it('creates a party after the duplicate check finds nothing', async () => {
    open('/master/parties');
    await screen.findByText('Al Noor Traders');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'New Vendor');
    await userEvent.type(screen.getByLabelText('CNIC'), '35202-1234567-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(written()).toHaveLength(2));
    expect(calls.find((c) => c.url.endsWith('check-duplicate'))?.body).toMatchObject({
      name: 'New Vendor',
      cnic: '35202-1234567-1',
    });
    expect(written()[1]).toMatchObject({
      method: 'POST',
      url: '/master/parties',
      body: { name: 'New Vendor', roles: ['vendor'], status: 'active' },
    });
  });

  it('warns about a repeated name and phone and saves only after confirmation (AC-1)', async () => {
    const duplicate = {
      id: 'p1',
      code: 'VN-0001',
      name: 'Al Noor Traders',
      reason: 'name_phone',
      blocking: false,
    };
    handler = (url, init) => {
      if (url.endsWith('check-duplicate')) return { body: { duplicates: [duplicate] } };
      if (init.method === 'POST') return { body: party };
      return { body: page([party]) };
    };
    open('/master/parties');
    await screen.findByText('Al Noor Traders');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Al Noor Traders');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/same name and phone already exists: Al Noor Traders \(VN-0001\)/),
    ).toBeInTheDocument();
    expect(written().filter((c) => c.url === '/master/parties')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() =>
      expect(written().find((c) => c.url === '/master/parties')?.body).toMatchObject({
        confirmDuplicate: true,
      }),
    );
  });

  it('blocks a repeated NTN or CNIC without offering to save anyway', async () => {
    handler = (url) =>
      url.endsWith('check-duplicate')
        ? {
            body: {
              duplicates: [
                {
                  id: 'p1',
                  code: 'VN-0001',
                  name: 'Al Noor Traders',
                  reason: 'ntn',
                  blocking: true,
                },
              ],
            },
          }
        : { body: page([party]) };
    open('/master/parties');
    await screen.findByText('Al Noor Traders');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Other');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/same NTN or CNIC already exists/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).not.toBeInTheDocument();
  });

  it('edits with the version of the record and shows an API error', async () => {
    let fail = true;
    handler = (url, init) => {
      if (url.endsWith('check-duplicate')) return { body: { duplicates: [] } };
      if (init.method === 'PUT') {
        return fail
          ? { status: 409, body: { error: { code: 'version_conflict', message: 'stale' } } }
          : { body: party };
      }
      return { body: page([party]) };
    };
    open('/master/parties');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit VN-0001' }));
    const city = screen.getByLabelText('City');
    expect(city).toHaveValue('Lahore');
    await userEvent.clear(city);
    await userEvent.type(city, 'Attock');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Someone else changed this record. Reload and try again.'),
    ).toBeInTheDocument();
    expect(written().find((c) => c.method === 'PUT')).toMatchObject({
      url: '/master/parties/p1',
      body: { city: 'Attock', version: 3 },
    });
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(written().filter((c) => c.method === 'PUT')).toHaveLength(2));
  });

  it('deletes after confirmation and reports a referenced party', async () => {
    handler = (url, init) => {
      if (init.method === 'DELETE') {
        return { status: 409, body: { error: { code: 'party_referenced', message: 'in use' } } };
      }
      return url.endsWith('check-duplicate')
        ? { body: { duplicates: [] } }
        : { body: page([party]) };
    };
    open('/master/parties');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete VN-0001' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(
      await screen.findByText('Documents use this party. Set it inactive instead.'),
    ).toBeInTheDocument();
    expect(written()[0]).toMatchObject({ method: 'DELETE', url: '/master/parties/p1?version=3' });
  });

  it('is read-only without the manage permission', async () => {
    permissions = ['master.party.read'];
    open('/master/parties');
    expect(await screen.findByText('Al Noor Traders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByText('You can view this data but not change it.')).toBeInTheDocument();
  });

  it('shows the no-access page without the read permission', async () => {
    permissions = ['master.item.read'];
    open('/master/parties');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/master/parties');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('items and units', () => {
  const unit = { code: 'bag', name: 'Bag', kind: 'count', version: 1 };
  const category = { id: 'c1', code: 'CEM', name: 'Cement', parentId: null, version: 1 };
  const item = {
    id: 'i1',
    code: 'ITM-1',
    name: 'Portland cement',
    categoryId: 'c1',
    unitCode: 'bag',
    itemKind: 'material',
    stockable: true,
    defaultTaxKind: 'goods',
    reorderLevel: null,
    defaultCostCodeId: null,
    active: true,
    version: 2,
  };

  it('lists items with their category and the categories below', async () => {
    handler = (url) => {
      if (url.startsWith('/master/items')) return { body: page([item]) };
      if (url.startsWith('/master/item-categories')) return { body: page([category]) };
      if (url.startsWith('/master/units')) return { body: page([unit]) };
      return undefined;
    };
    open('/master/items');
    expect(await screen.findByText('Portland cement')).toBeInTheDocument();
    expect(await screen.findAllByText('Cement')).not.toHaveLength(0);
    expect(screen.getAllByText('Item categories').length).toBeGreaterThan(0);
  });

  it('adds an item with the chosen unit and sends no category when none is chosen', async () => {
    handler = (url, init) => {
      if (init.method === 'POST') return { body: item };
      if (url.startsWith('/master/items')) return { body: page([item]) };
      if (url.startsWith('/master/units')) return { body: page([unit]) };
      return undefined;
    };
    open('/master/items');
    await screen.findByText('Portland cement');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0] as HTMLElement);
    await userEvent.type(screen.getByLabelText('Code'), 'ITM-2');
    await userEvent.type(screen.getAllByLabelText('Name')[0] as HTMLElement, 'Sand');
    await userEvent.click(screen.getByLabelText('Unit'));
    await userEvent.click(await screen.findByText('bag Bag'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(written()).toHaveLength(1));
    expect(written()[0]?.body).toMatchObject({
      code: 'ITM-2',
      name: 'Sand',
      unitCode: 'bag',
      itemKind: 'material',
      categoryId: null,
      defaultCostCodeId: null,
      reorderLevel: null,
    });
  });

  it('converts a quantity and shows the answer or the error (AC-2)', async () => {
    handler = (url) => {
      if (url.startsWith('/master/units/convert?quantity=2500')) {
        return { body: { quantity: '2.5000', unit: 'ton' } };
      }
      if (url.startsWith('/master/units/convert')) {
        return { status: 422, body: { error: { code: 'conversion_missing', message: 'no pair' } } };
      }
      if (url.startsWith('/master/units')) {
        return {
          body: page([
            unit,
            { code: 'kg', name: 'Kilogram', kind: 'weight', version: 1 },
            { code: 'ton', name: 'Ton', kind: 'weight', version: 1 },
          ]),
        };
      }
      return undefined;
    };
    open('/master/units');
    const quantity = await screen.findByLabelText('Quantity');
    // The converter's selects come last on the page, after the (closed) conversion form.
    const choose = async (label: string, option: string) => {
      const boxes = screen.getAllByRole('combobox', { name: label });
      await userEvent.click(boxes[boxes.length - 1] as HTMLElement);
      const choices = await screen.findAllByText(option);
      await userEvent.click(choices[choices.length - 1] as HTMLElement);
    };
    await userEvent.type(quantity, '2500');
    await choose('From unit', 'kg Kilogram');
    await choose('To unit', 'ton Ton');
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('2.5000 ton')).toBeInTheDocument();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1');
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(
      await screen.findByText('There is no conversion between these units.'),
    ).toBeInTheDocument();
  });

  it('validates a conversion factor', async () => {
    handler = (url) => (url.startsWith('/master/units') ? { body: page([unit]) } : undefined);
    open('/master/units');
    await screen.findByText('Bag');
    const adds = await screen.findAllByRole('button', { name: 'Add' });
    await userEvent.click(adds[1] as HTMLElement);
    await userEvent.type(screen.getByLabelText('Factor (1 from-unit = factor to-units)'), '1,000');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a number without separators')).toBeInTheDocument();
  });
});

describe('cost codes, locations, prices and company', () => {
  it('shows cost codes as a tree', async () => {
    const root = {
      id: 'c100',
      code: '100',
      name: 'Materials',
      parentId: null,
      kind: 'material',
      active: true,
      version: 1,
    };
    const child = {
      id: 'c101',
      code: '101',
      name: 'Cement',
      parentId: 'c100',
      kind: 'material',
      active: true,
      version: 1,
    };
    handler = () => ({ body: page([root, child]) });
    open('/master/cost-codes');
    expect(await screen.findByText('Materials')).toBeInTheDocument();
    expect(screen.queryByText('Cement')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /expand row/i }));
    expect(await screen.findByText('Cement')).toBeInTheDocument();
  });

  it('adds a location', async () => {
    handler = (_url, init) => ({
      body:
        init.method === 'POST'
          ? {}
          : page([
              { id: 'l1', name: 'Head office', region: 'islamabad', city: 'Islamabad', version: 1 },
            ]),
    });
    open('/master/locations');
    expect(await screen.findByText('Head office')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Yard');
    await userEvent.type(screen.getByLabelText('City'), 'Lahore');
    await userEvent.click(screen.getByLabelText('Region'));
    await userEvent.click(await screen.findByText('Punjab'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(written()).toHaveLength(1));
    expect(written()[0]?.body).toMatchObject({ name: 'Yard', region: 'punjab', city: 'Lahore' });
  });

  it('lists vendor prices with names and dates, and checks the date format', async () => {
    const vendor = { ...party, id: 'v1' };
    const item = { id: 'i1', code: 'ITM-1', name: 'Portland cement', unitCode: 'bag', version: 1 };
    handler = (url) => {
      if (url.startsWith('/master/vendor-prices')) {
        return {
          body: page([
            {
              id: 'pr1',
              vendorId: 'v1',
              itemId: 'i1',
              unitCode: 'bag',
              rate: '1250.5000',
              validFrom: '2026-01-31',
              validTo: null,
              version: 1,
            },
          ]),
        };
      }
      if (url.startsWith('/master/parties')) return { body: page([vendor]) };
      if (url.startsWith('/master/items')) return { body: page([item]) };
      return { body: page([]) };
    };
    open('/master/vendor-prices');
    expect(await screen.findByText('1250.5000')).toBeInTheDocument();
    expect(await screen.findByText('31/01/2026')).toBeInTheDocument();
    expect(await screen.findAllByText('Al Noor Traders')).not.toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Valid from'), '31/01/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use the format yyyy-mm-dd')).toBeInTheDocument();
  });

  it('saves the first company profile without a version, then with it', async () => {
    let profile: unknown = undefined;
    handler = (url, init) => {
      if (url === '/master/company' && init.method === 'PUT') {
        profile = {
          id: 'co1',
          name: 'Example Co',
          address: null,
          phone: null,
          email: null,
          version: 1,
        };
        return { body: profile };
      }
      if (url === '/master/company') {
        return profile === undefined
          ? { status: 404, body: { error: { code: 'company_not_found', message: 'none' } } }
          : { body: profile };
      }
      if (url.startsWith('/master/tax-registrations')) {
        return {
          body: page([
            {
              id: 'r1',
              authority: 'FBR',
              registrationType: 'ntn',
              number: 'SYNTH-1',
              validFrom: '2026-01-01',
              validTo: null,
              version: 1,
            },
          ]),
        };
      }
      return undefined;
    };
    open('/master/company');
    expect(await screen.findByText('SYNTH-1')).toBeInTheDocument();
    expect(screen.getByText('01/01/2026')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Company name'), 'Example Co');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    expect(await screen.findByText('Company profile saved.')).toBeInTheDocument();
    expect(written()[0]?.body).toEqual({ name: 'Example Co' });
    await waitFor(() => expect(screen.getByLabelText('Company name')).toHaveValue('Example Co'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(written()).toHaveLength(2));
    expect(written()[1]?.body).toMatchObject({ name: 'Example Co', version: 1 });
  });

  it('shows a company save error and a read-only form without the manage permission', async () => {
    handler = (url, init) => {
      if (url === '/master/company' && init.method === 'PUT') {
        return {
          status: 409,
          body: { error: { code: 'version_required', message: 'send version' } },
        };
      }
      if (url === '/master/company')
        return { status: 404, body: { error: { code: 'company_not_found', message: 'x' } } };
      return undefined;
    };
    open('/master/company');
    await userEvent.type(await screen.findByLabelText('Company name'), 'X');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    expect(await screen.findByText('send version')).toBeInTheDocument();
  });

  it('hides editing from users who cannot manage the company', async () => {
    permissions = ['master.reference.read'];
    handler = (url) => {
      if (url === '/master/company')
        return {
          body: {
            id: 'co1',
            name: 'Example Co',
            address: null,
            phone: null,
            email: null,
            version: 1,
          },
        };
      return undefined;
    };
    open('/master/company');
    await waitFor(() => expect(screen.getByLabelText('Company name')).toHaveValue('Example Co'));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(
      within(document.body).getAllByText('You can view this data but not change it.'),
    ).not.toHaveLength(0);
  });
});
