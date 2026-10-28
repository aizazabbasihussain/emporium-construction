import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  NOBODY,
  PROCUREMENT,
  STOREKEEPER,
  SUPERVISOR,
  createMasterKit,
  uid,
  type MasterKit,
} from '../test-support.js';

let kit: MasterKit;

beforeAll(async () => {
  kit = await createMasterKit();
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = ADMIN, body, key }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json<unknown>(),
  };
};
const json = <T>(r: { body: unknown }) => r.body as T;

let keyCounter = 0;
const newKey = () => `route-key-${++keyCounter}`;

/** Creates through the API and returns the created record. */
const make = async <T extends { id?: string }>(
  url: string,
  body: unknown,
  user = ADMIN,
): Promise<T> => {
  const r = await call({ method: 'POST', url, body, user });
  expect(r.status).toBe(201);
  return json<T>(r);
};

describe('company profile', () => {
  it('is not found until saved, then saved and read (success, not found)', async () => {
    expect((await call({ method: 'GET', url: '/master/company' })).status).toBe(404);
    const saved = await call({
      method: 'PUT',
      url: '/master/company',
      body: { name: 'Example Co', phone: '051-1234567' },
    });
    expect(saved.status).toBe(200);
    expect(json<{ phone: string }>(saved).phone).toBe('+92511234567');
    expect((await call({ method: 'GET', url: '/master/company', user: SUPERVISOR })).status).toBe(
      200,
    );
  });

  it('answers 409 for a missing or stale version, 400 for bad input and 403 without permission', async () => {
    expect(
      (await call({ method: 'PUT', url: '/master/company', body: { name: 'X' } })).status,
    ).toBe(409);
    expect(
      (await call({ method: 'PUT', url: '/master/company', body: { name: 'X', version: 9 } }))
        .status,
    ).toBe(409);
    expect((await call({ method: 'PUT', url: '/master/company', body: { name: '' } })).status).toBe(
      400,
    );
    expect(
      (
        await call({
          method: 'PUT',
          url: '/master/company',
          body: { name: 'X' },
          user: PROCUREMENT,
        })
      ).status,
    ).toBe(403);
    expect((await call({ method: 'GET', url: '/master/company', user: NOBODY })).status).toBe(403);
  });

  it('replays an idempotent retry', async () => {
    const key = newKey();
    const first = await call({
      method: 'PUT',
      url: '/master/company',
      body: { name: 'Retry Co', version: 1 },
      key,
    });
    const retry = await call({
      method: 'PUT',
      url: '/master/company',
      body: { name: 'Retry Co', version: 1 },
      key,
    });
    expect(first.status).toBe(200);
    expect(retry).toEqual(first);
  });
});

describe('tax registrations and locations', () => {
  const registration = {
    authority: 'FBR',
    registrationType: 'ntn',
    number: 'SYNTH-1',
    validFrom: '2026-01-01',
  };

  it('creates, lists, finds the current one, updates and deletes a registration', async () => {
    const created = await make<{ id: string; version: number }>(
      '/master/tax-registrations',
      registration,
    );
    const list = await call({
      method: 'GET',
      url: '/master/tax-registrations?q=synth&sort=authority',
    });
    expect(json<{ total: number }>(list).total).toBe(1);
    const current = await call({
      method: 'GET',
      url: '/master/tax-registrations/current?authority=fbr&date=2026-05-01&type=ntn',
    });
    expect(json<{ id: string }>(current).id).toBe(created.id);
    expect(
      (await call({ method: 'GET', url: '/master/tax-registrations/current?authority=fbr' }))
        .status,
    ).toBe(200);
    expect(
      (await call({ method: 'GET', url: '/master/tax-registrations/current?authority=pra' }))
        .status,
    ).toBe(404);
    const updated = await call({
      method: 'PUT',
      url: `/master/tax-registrations/${created.id}`,
      body: { ...registration, number: 'SYNTH-2', version: 1 },
    });
    expect(updated.status).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/tax-registrations/${created.id}`,
          body: { ...registration, version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/tax-registrations/${created.id}?version=2` }))
        .status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/tax-registrations/${created.id}?version=3` }))
        .status,
    ).toBe(404);
  });

  it('rejects overlap (422), invalid input (400), a missing record (404) and a missing permission (403)', async () => {
    await make('/master/tax-registrations', { ...registration, authority: 'OVR' });
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/tax-registrations',
          body: { ...registration, authority: 'OVR' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/tax-registrations',
          body: { ...registration, validFrom: 'soon' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/tax-registrations/${uid(8001)}`,
          body: { ...registration, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/tax-registrations',
          body: registration,
          user: ACCOUNTANT,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call({ method: 'DELETE', url: `/master/tax-registrations/${uid(8001)}` })).status,
    ).toBe(400);
    expect(
      (await call({ method: 'GET', url: '/master/tax-registrations', user: NOBODY })).status,
    ).toBe(403);
  });

  it('manages locations', async () => {
    const body = { name: 'Head office', region: 'islamabad', city: 'Islamabad' };
    const created = await make<{ id: string }>('/master/locations', body);
    await make('/master/locations', { name: 'Yard', region: 'punjab', city: 'Lahore' });
    expect(
      json<{ total: number }>(await call({ method: 'GET', url: '/master/locations' })).total,
    ).toBe(2);
    expect(
      json<{ items: { name: string }[] }>(
        await call({ method: 'GET', url: '/master/locations?region=punjab' }),
      ).items[0]?.name,
    ).toBe('Yard');
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/locations/${created.id}`,
          body: { ...body, name: 'Main', version: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/locations/${created.id}`,
          body: { ...body, version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/locations/${uid(8002)}`,
          body: { ...body, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', url: '/master/locations', body: { ...body, region: 'sindh' } }))
        .status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: '/master/locations', body, user: PROCUREMENT })).status,
    ).toBe(403);
    expect(
      (await call({ method: 'DELETE', url: `/master/locations/${created.id}?version=2` })).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/locations/${created.id}?version=3` })).status,
    ).toBe(404);
  });
});

describe('parties', () => {
  const body = {
    name: 'Route Vendor',
    roles: ['vendor', 'subcontractor'],
    phone: '0300 7000001',
    ntn: '7000001-1',
    cnic: '35202-7000001-1',
    contacts: [{ name: 'Contact', phone: '0301 7000002' }],
  };

  it('creates, reads, finds and updates a party with several roles (AC-1)', async () => {
    const created = await call({ method: 'POST', url: '/master/parties', body });
    expect(created.status).toBe(201);
    const party = json<{ id: string; code: string; version: number; roles: string[] }>(created);
    expect(party.roles).toEqual(['vendor', 'subcontractor']);
    expect(
      json<{ id: string }>(
        await call({ method: 'GET', url: `/master/parties/${party.id}`, user: PROCUREMENT }),
      ).id,
    ).toBe(party.id);
    for (const q of ['route vendor', '7000001-1', '3520270000011', party.code]) {
      const found = await call({
        method: 'GET',
        url: `/master/parties?q=${encodeURIComponent(q)}&role=vendor&status=active&sort=code&direction=desc&limit=5`,
      });
      expect(json<{ items: { id: string }[]; limit: number }>(found)).toMatchObject({ limit: 5 });
      expect(json<{ items: { id: string }[] }>(found).items.map((p) => p.id)).toContain(party.id);
    }
    const updated = await call({
      method: 'PUT',
      url: `/master/parties/${party.id}`,
      body: { ...body, city: 'Attock', version: party.version },
    });
    expect(json<{ city: string; version: number }>(updated)).toMatchObject({
      city: 'Attock',
      version: 2,
    });
  });

  it('flags a repeat as a duplicate and lets a name and phone repeat be confirmed (AC-1)', async () => {
    expect((await call({ method: 'POST', url: '/master/parties', body })).status).toBe(409);
    const warning = { name: 'Warn Co', roles: ['client'], phone: '0300 7000003' };
    await make('/master/parties', warning);
    const refused = await call({ method: 'POST', url: '/master/parties', body: warning });
    expect(refused.status).toBe(409);
    expect(
      json<{ error: { code: string; details: { matches: unknown[] } } }>(refused).error,
    ).toMatchObject({ code: 'duplicate_warning' });
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/parties',
          body: { ...warning, confirmDuplicate: true },
        })
      ).status,
    ).toBe(201);
    const check = await call({
      method: 'POST',
      url: '/master/parties/check-duplicate',
      body: { name: 'warn co', phone: '+92 300 7000003' },
      user: PROCUREMENT,
    });
    expect(
      json<{ duplicates: { blocking: boolean; reason: string }[] }>(check).duplicates[0],
    ).toMatchObject({ reason: 'name_phone', blocking: false });
    expect(
      (await call({ method: 'POST', url: '/master/parties/check-duplicate', body: { name: '' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/parties/check-duplicate',
          body: { name: 'x' },
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
  });

  it('rejects bad input (400), an unknown party (404), a stale version (409) and missing permissions (403)', async () => {
    expect(
      (await call({ method: 'POST', url: '/master/parties', body: { name: 'X', roles: [] } }))
        .status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: '/master/parties', body: { name: 'X', roles: ['boss'] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/parties',
          body: { name: 'X', roles: ['client'], cnic: '123' },
        })
      ).status,
    ).toBe(400);
    expect((await call({ method: 'GET', url: '/master/parties/not-a-uuid' })).status).toBe(400);
    expect((await call({ method: 'GET', url: `/master/parties/${uid(8003)}` })).status).toBe(404);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/parties/${uid(8003)}`,
          body: { ...body, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await call({ method: 'GET', url: '/master/parties', user: STOREKEEPER })).status).toBe(
      403,
    );
    expect((await call({ method: 'GET', url: '/master/parties', user: SUPERVISOR })).status).toBe(
      403,
    );
    expect(
      (await call({ method: 'POST', url: '/master/parties', body, user: ACCOUNTANT })).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/parties',
          body: { name: 'Y', roles: ['client'] },
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
    const party = await make<{ id: string }>('/master/parties', {
      name: 'Stale',
      roles: ['client'],
    });
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/parties/${party.id}`,
          body: { name: 'Stale', roles: ['client'], version: 9 },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/parties/${party.id}?version=9` })).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/parties/${uid(8003)}?version=1` })).status,
    ).toBe(404);
  });

  it('deletes softly, refuses a referenced party and replays an idempotent retry', async () => {
    const free = await make<{ id: string }>('/master/parties', {
      name: 'Delete Route',
      roles: ['client'],
    });
    expect(
      (await call({ method: 'DELETE', url: `/master/parties/${free.id}?version=1` })).status,
    ).toBe(204);
    expect((await call({ method: 'GET', url: `/master/parties/${free.id}` })).status).toBe(404);
    const used = await make<{ id: string }>('/master/parties', {
      name: 'Used Route',
      roles: ['client'],
    });
    kit.masterData.registerReferenceCheck('party', (_db, id) => Promise.resolve(id === used.id));
    expect(
      (await call({ method: 'DELETE', url: `/master/parties/${used.id}?version=1` })).status,
    ).toBe(409);
    const key = newKey();
    const payload = { name: 'Idem Party', roles: ['client'] };
    const first = await call({ method: 'POST', url: '/master/parties', body: payload, key });
    const retry = await call({ method: 'POST', url: '/master/parties', body: payload, key });
    expect(first.status).toBe(201);
    expect(retry).toEqual(first);
  });
});

describe('units and conversions', () => {
  it('lists, converts in both directions and fails for unrelated units (AC-2)', async () => {
    expect(
      json<{ total: number }>(
        await call({ method: 'GET', url: '/master/units?q=metre', user: STOREKEEPER }),
      ).total,
    ).toBeGreaterThan(0);
    await make(
      '/master/unit-conversions',
      { fromUnit: 'ton', toUnit: 'kg', factor: '1000' },
      PROCUREMENT,
    );
    const there = await call({
      method: 'GET',
      url: '/master/units/convert?quantity=2.5&from=ton&to=kg',
    });
    expect(json<{ quantity: string; unit: string }>(there)).toEqual({
      quantity: '2500.0000',
      unit: 'kg',
    });
    expect(
      json<{ quantity: string }>(
        await call({ method: 'GET', url: '/master/units/convert?quantity=2500&from=kg&to=ton' }),
      ).quantity,
    ).toBe('2.5000');
    expect(
      (await call({ method: 'GET', url: '/master/units/convert?quantity=1&from=kg&to=m' })).status,
    ).toBe(422);
    expect(
      (await call({ method: 'GET', url: '/master/units/convert?quantity=abc&from=kg&to=m' }))
        .status,
    ).toBe(400);
    expect(
      (await call({ method: 'GET', url: '/master/units/convert?quantity=1&from=kg&to=nope' }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'GET',
          url: '/master/units/convert?quantity=1&from=kg&to=m',
          user: NOBODY,
        })
      ).status,
    ).toBe(403);
  });

  it('manages units', async () => {
    const created = await call({
      method: 'POST',
      url: '/master/units',
      body: { code: 'pcs', name: 'Pieces', kind: 'count' },
      user: PROCUREMENT,
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/units',
          body: { code: 'pcs', name: 'Pieces', kind: 'count' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/units',
          body: { code: 'zz', name: 'Z', kind: 'speed' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/units',
          body: { code: 'zz', name: 'Z', kind: 'count' },
          user: ACCOUNTANT,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'PUT',
          url: '/master/units/pcs',
          body: { name: 'Piece', kind: 'count', version: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: '/master/units/pcs',
          body: { name: 'Piece', kind: 'count', version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: '/master/units/nope',
          body: { name: 'Piece', kind: 'count', version: 1 },
        })
      ).status,
    ).toBe(404);
    expect((await call({ method: 'DELETE', url: '/master/units/pcs?version=1' })).status).toBe(409);
    expect((await call({ method: 'DELETE', url: '/master/units/pcs?version=2' })).status).toBe(204);
    expect((await call({ method: 'DELETE', url: '/master/units/pcs?version=2' })).status).toBe(404);
  });

  it('manages conversions', async () => {
    const created = await make<{ id: string }>('/master/unit-conversions', {
      fromUnit: 'sqm',
      toUnit: 'sqft',
      factor: '10.763910',
    });
    expect(
      json<{ total: number }>(
        await call({ method: 'GET', url: '/master/unit-conversions?q=sqm&sort=from' }),
      ).total,
    ).toBe(1);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/unit-conversions',
          body: { fromUnit: 'sqft', toUnit: 'sqm', factor: '1' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/unit-conversions',
          body: { fromUnit: 'sqm', toUnit: 'sqm', factor: '1' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/unit-conversions',
          body: { fromUnit: 'sqm', toUnit: 'cum', factor: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/unit-conversions',
          body: { fromUnit: 'cum', toUnit: 'cuft', factor: '35' },
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/unit-conversions/${created.id}`,
          body: { factor: '10.76', version: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/unit-conversions/${created.id}`,
          body: { factor: '10', version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/unit-conversions/${uid(8004)}`,
          body: { factor: '10', version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'DELETE', url: `/master/unit-conversions/${created.id}?version=2` }))
        .status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/unit-conversions/${created.id}?version=2` }))
        .status,
    ).toBe(404);
  });
});

describe('item categories and items', () => {
  it('manages categories', async () => {
    const root = await make<{ id: string }>(
      '/master/item-categories',
      { code: 'R-ROOT', name: 'Root' },
      PROCUREMENT,
    );
    const child = await make<{ id: string }>('/master/item-categories', {
      code: 'R-CHILD',
      name: 'Child',
      parentId: root.id,
    });
    expect(
      json<{ total: number }>(
        await call({
          method: 'GET',
          url: '/master/item-categories?q=r-&sort=code&direction=desc',
          user: STOREKEEPER,
        }),
      ).total,
    ).toBe(2);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/item-categories/${root.id}`,
          body: { code: 'R-ROOT', name: 'Root', parentId: child.id, version: 1 },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/item-categories/${child.id}`,
          body: { code: 'R-CHILD', name: 'Child 2', parentId: root.id, version: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/item-categories/${child.id}`,
          body: { code: 'R-CHILD', name: 'Child 3', version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/item-categories/${uid(8005)}`,
          body: { code: 'Q', name: 'Q', version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/item-categories',
          body: { code: 'R-ROOT', name: 'Again' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/item-categories',
          body: { code: '', name: 'Again' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/item-categories',
          body: { code: 'Z', name: 'Z' },
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call({ method: 'GET', url: '/master/item-categories', user: NOBODY })).status,
    ).toBe(403);
    expect(
      (await call({ method: 'DELETE', url: `/master/item-categories/${root.id}?version=1` }))
        .status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/item-categories/${child.id}?version=2` }))
        .status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/item-categories/${child.id}?version=2` }))
        .status,
    ).toBe(404);
  });

  const item = {
    code: 'RI-1',
    name: 'Route cement',
    unitCode: 'bag',
    itemKind: 'material',
    defaultTaxKind: 'goods',
    reorderLevel: '25',
  };

  it('creates, reads, searches, updates and deletes an item', async () => {
    const created = await call({
      method: 'POST',
      url: '/master/items',
      body: item,
      user: PROCUREMENT,
    });
    expect(created.status).toBe(201);
    const row = json<{ id: string; stockable: boolean }>(created);
    expect(row.stockable).toBe(true);
    expect(
      json<{ id: string }>(
        await call({ method: 'GET', url: `/master/items/${row.id}`, user: STOREKEEPER }),
      ).id,
    ).toBe(row.id);
    const found = await call({
      method: 'GET',
      url: '/master/items?q=route&kind=material&active=true&sort=name&direction=desc&limit=10',
      user: STOREKEEPER,
    });
    expect(json<{ items: { id: string }[] }>(found).items.map((i) => i.id)).toEqual([row.id]);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/items/${row.id}`,
          body: { ...item, name: 'Renamed', version: 1 },
          user: PROCUREMENT,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call({ method: 'PUT', url: `/master/items/${row.id}`, body: { ...item, version: 1 } }))
        .status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/items/${row.id}?version=2` })).status,
    ).toBe(204);
    expect((await call({ method: 'GET', url: `/master/items/${row.id}` })).status).toBe(404);
  });

  it('keeps the default cost code of an item and refuses an unknown one (P1-12)', async () => {
    const codes = json<{ items: { id: string }[] }>(
      await call({
        method: 'GET',
        url: '/master/cost-codes?sort=code&limit=200',
        user: SUPERVISOR,
      }),
    );
    const costCodeId = (codes.items[0] as { id: string }).id;
    const created = await call({
      method: 'POST',
      url: '/master/items',
      body: { ...item, code: 'RI-DC', defaultCostCodeId: costCodeId },
      user: PROCUREMENT,
    });
    expect(created.status).toBe(201);
    expect(json<{ defaultCostCodeId: string }>(created).defaultCostCodeId).toBe(costCodeId);
    const bad = await call({
      method: 'POST',
      url: '/master/items',
      body: { ...item, code: 'RI-DC2', defaultCostCodeId: '018f7a7a-0000-7000-8000-000000000999' },
      user: PROCUREMENT,
    });
    expect(bad.status).toBe(400);
  });

  it('rejects invalid items (400, 422), unknown items (404), conflicts (409) and missing permissions (403)', async () => {
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/items',
          body: { ...item, code: 'RI-2', itemKind: 'service', stockable: true },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/items',
          body: { ...item, code: 'RI-3', unitCode: 'nope' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/items',
          body: { ...item, code: 'RI-3', itemKind: 'gadget' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/items',
          body: { ...item, code: 'RI-3', reorderLevel: '-1' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/items',
          body: { ...item, code: 'RI-4' },
          user: STOREKEEPER,
        })
      ).status,
    ).toBe(403);
    expect((await call({ method: 'GET', url: '/master/items', user: NOBODY })).status).toBe(403);
    await make('/master/items', { ...item, code: 'RI-5' });
    expect(
      (await call({ method: 'POST', url: '/master/items', body: { ...item, code: 'RI-5' } }))
        .status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/items/${uid(8006)}`,
          body: { ...item, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'DELETE', url: `/master/items/${uid(8006)}?version=1` })).status,
    ).toBe(404);
    const used = await make<{ id: string }>('/master/items', { ...item, code: 'RI-6' });
    kit.masterData.registerReferenceCheck('item', (_db, id) => Promise.resolve(id === used.id));
    expect(
      (await call({ method: 'DELETE', url: `/master/items/${used.id}?version=1` })).status,
    ).toBe(409);
    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/master/items',
      body: { ...item, code: 'RI-7' },
      key,
    });
    expect(
      await call({ method: 'POST', url: '/master/items', body: { ...item, code: 'RI-7' }, key }),
    ).toEqual(first);
  });
});

describe('cost codes', () => {
  it('lists the seeded tree and manages sub-codes (AC-3)', async () => {
    const list = await call({
      method: 'GET',
      url: '/master/cost-codes?sort=code&limit=200',
      user: SUPERVISOR,
    });
    expect(json<{ items: { code: string; id: string }[] }>(list).items.map((c) => c.code)).toEqual([
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
    ]);
    const root = json<{ items: { code: string; id: string }[] }>(list).items[0] as { id: string };
    const created = await call({
      method: 'POST',
      url: '/master/cost-codes',
      body: { code: '101', name: 'Cement', parentId: root.id, kind: 'material' },
      user: ACCOUNTANT,
    });
    expect(created.status).toBe(201);
    const code = json<{ id: string }>(created);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/cost-codes/${root.id}`,
          body: { code: '100', name: 'Materials', parentId: code.id, kind: 'material', version: 1 },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/cost-codes/${code.id}`,
          body: {
            code: '101',
            name: 'Cement 2',
            parentId: root.id,
            kind: 'material',
            active: false,
            version: 1,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/cost-codes/${code.id}`,
          body: { code: '101', name: 'Cement 3', kind: 'material', version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/cost-codes/${uid(8007)}`,
          body: { code: '1', name: 'Q', kind: 'material', version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/cost-codes',
          body: { code: '101', name: 'Again', kind: 'material' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/cost-codes',
          body: { code: '9', name: 'X', kind: 'magic' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/cost-codes',
          body: { code: '9', name: 'X', kind: 'labour' },
          user: PROCUREMENT,
        })
      ).status,
    ).toBe(403);
    expect((await call({ method: 'GET', url: '/master/cost-codes', user: NOBODY })).status).toBe(
      403,
    );
    expect(
      (await call({ method: 'DELETE', url: `/master/cost-codes/${root.id}?version=1` })).status,
    ).toBe(409);
    expect(
      (await call({ method: 'DELETE', url: `/master/cost-codes/${code.id}?version=2` })).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/cost-codes/${code.id}?version=2` })).status,
    ).toBe(404);
  });
});

describe('vendor prices', () => {
  it('manages the price list', async () => {
    const vendor = await make<{ id: string }>('/master/parties', {
      name: 'Price Route Vendor',
      roles: ['vendor'],
    });
    const item = await make<{ id: string }>('/master/items', {
      code: 'PR-1',
      name: 'Priced',
      unitCode: 'bag',
      itemKind: 'material',
      defaultTaxKind: 'goods',
    });
    const body = {
      vendorId: vendor.id,
      itemId: item.id,
      unitCode: 'bag',
      rate: '1250.5',
      validFrom: '2026-01-01',
    };
    const created = await call({
      method: 'POST',
      url: '/master/vendor-prices',
      body,
      user: PROCUREMENT,
    });
    expect(created.status).toBe(201);
    const price = json<{ id: string }>(created);
    const found = await call({
      method: 'GET',
      url: `/master/vendor-prices?vendorId=${vendor.id}&itemId=${item.id}&onDate=2026-06-01`,
      user: ACCOUNTANT,
    });
    expect(json<{ total: number }>(found).total).toBe(1);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/vendor-prices/${price.id}`,
          body: { ...body, rate: '1300', version: 1 },
          user: PROCUREMENT,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/vendor-prices/${price.id}`,
          body: { ...body, version: 1 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/master/vendor-prices/${uid(8008)}`,
          body: { ...body, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'POST', url: '/master/vendor-prices', body: { ...body, rate: '-1' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: '/master/vendor-prices',
          body: { ...body, vendorId: uid(8009) },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: '/master/vendor-prices', body, user: ACCOUNTANT })).status,
    ).toBe(403);
    expect(
      (await call({ method: 'GET', url: '/master/vendor-prices', user: STOREKEEPER })).status,
    ).toBe(403);
    expect(
      (
        await call({
          method: 'DELETE',
          url: `/master/vendor-prices/${price.id}?version=2`,
          user: PROCUREMENT,
        })
      ).status,
    ).toBe(204);
    expect(
      (await call({ method: 'DELETE', url: `/master/vendor-prices/${price.id}?version=2` })).status,
    ).toBe(404);
  });
});

describe('authentication', () => {
  it('needs a token on every endpoint', async () => {
    const response = await kit.app.inject({ method: 'GET', url: '/master/parties' });
    expect(response.statusCode).toBe(401);
  });
});
