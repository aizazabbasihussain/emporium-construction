import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, createMasterKit, eventCount, uid, type MasterKit } from '../test-support.js';
import type { PartyInput } from './parties.service.js';

let kit: MasterKit;
const parties = () => kit.masterData.parties;
const create = (input: Partial<PartyInput> = {}, confirmDuplicate = false) =>
  kit.db.transaction((tx) =>
    parties().create({ name: 'Al Noor Traders', roles: ['vendor'], ...input }, kit.actor, tx, {
      confirmDuplicate,
    }),
  );

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeAll(async () => {
  kit = await createMasterKit();
}, 60_000);
afterAll(() => kit.close());

describe('creating parties (AC-1, BR-1)', () => {
  it('creates a party with several roles and a code from the series of the first role', async () => {
    const party = await create({
      name: '  Bashir Builders ',
      roles: ['vendor', 'subcontractor', 'vendor'],
      phone: '0300-1112223',
      cnic: '35202-1111111-1',
      ntn: '7654321-0',
      email: ' bashir@example.test ',
      contacts: [{ name: 'Site contact', phone: '0301 2223334', role: 'foreman' }],
    });
    expect(party).toMatchObject({
      code: expect.stringMatching(/^VN-\d{4}$/) as unknown,
      name: 'Bashir Builders',
      roles: ['vendor', 'subcontractor'],
      phone: '+923001112223',
      cnic: '3520211111111',
      ntn: '76543210',
      email: 'bashir@example.test',
      status: 'active',
      contacts: [{ name: 'Site contact', phone: '+923012223334', role: 'foreman', email: null }],
    });
    expect(await parties().get(kit.db, party.id)).toEqual(party);
    expect(await auditCount(kit.db, 'master.party.create')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'master.party.changed')).toBeGreaterThan(0);
  });

  it('numbers each kind from its own series', async () => {
    const client = await create({ name: 'Client One', roles: ['client'] });
    const next = await create({ name: 'Client Two', roles: ['client'] });
    expect(client.code).toMatch(/^CL-\d{4}$/);
    expect(Number(next.code.slice(3))).toBe(Number(client.code.slice(3)) + 1);
    expect((await create({ name: 'Sub One', roles: ['subcontractor'] })).code).toMatch(/^SC-/);
    expect((await create({ name: 'Crew One', roles: ['labour_contractor'] })).code).toMatch(/^LC-/);
  });

  it.each([
    ['name missing', { name: '   ' }, 'name_required'],
    ['no roles', { roles: [] }, 'invalid_roles'],
    ['unknown role', { roles: ['owner'] }, 'invalid_roles'],
    ['bad status', { status: 'gone' }, 'invalid_status'],
    ['short CNIC', { cnic: '123' }, 'invalid_cnic'],
    ['bad phone', { phone: '+1 415 555 0100' }, 'invalid_phone'],
    ['bad NTN', { ntn: '!!' }, 'invalid_tax_number'],
    ['nameless contact', { contacts: [{ name: ' ' }] }, 'contact_name_required'],
  ] as const)('rejects %s', async (_label, input, code) => {
    expect(await codeOf(create(input as Partial<PartyInput>))).toBe(code);
  });
});

describe('duplicate protection (T-1, BR-2)', () => {
  it('warns about the same name and phone and lets the user confirm', async () => {
    await create({ name: 'Dup Phone Co', phone: '0310 5550001' });
    expect(await codeOf(create({ name: ' dup  phone co', phone: '+92 310 5550001' }))).toBe(
      'duplicate_warning',
    );
    const confirmed = await create({ name: 'Dup Phone Co', phone: '0310 5550001' }, true);
    expect(confirmed.id).toBeDefined();
  });

  it('refuses a repeated NTN or CNIC even when confirmed', async () => {
    await create({ name: 'Tax Holder', ntn: '5550001-1', cnic: '3520255500011' });
    expect(await codeOf(create({ name: 'Other One', ntn: '5550001-1' }, true))).toBe(
      'duplicate_party',
    );
    expect(await codeOf(create({ name: 'Other Two', cnic: '35202-5550001-1' }, true))).toBe(
      'duplicate_party',
    );
  });

  it('lets an inactive party keep its NTN while an active one is created with it', async () => {
    const old = await create({ name: 'Old Entity', ntn: '5550002-2', status: 'inactive' });
    const fresh = await create({ name: 'New Entity', ntn: '5550002-2' });
    expect(old.id).not.toBe(fresh.id);
    // The inactive party cannot be switched on again while the NTN is taken.
    expect(
      await codeOf(
        kit.db.transaction((tx) =>
          parties().update(
            old.id,
            { name: 'Old Entity', roles: ['vendor'], ntn: '5550002-2', status: 'active' },
            old.version,
            kit.actor,
            tx,
          ),
        ),
      ),
    ).toBe('duplicate_party');
  });

  it('reports matches with their reason and whether they block', async () => {
    const holder = await create({ name: 'Report Holder', phone: '0311 5550003', ntn: '5550003-3' });
    const found = await parties().checkDuplicate(kit.db, {
      name: 'report holder',
      phone: '0311-5550003',
      ntn: '5550003-3',
    });
    expect(found).toEqual([
      { id: holder.id, reason: 'ntn', code: holder.code, name: 'Report Holder', blocking: true },
    ]);
    const warning = await parties().checkDuplicate(kit.db, {
      name: 'report holder',
      phone: '0311-5550003',
    });
    expect(warning[0]).toMatchObject({ reason: 'name_phone', blocking: false });
    expect(
      await parties().checkDuplicate(kit.db, { name: 'report holder', excludeId: holder.id }),
    ).toEqual([]);
    expect(await codeOf(parties().checkDuplicate(kit.db, { name: ' ' }))).toBe('name_required');
  });
});

describe('updating, finding and deleting', () => {
  it('updates with the expected version and keeps the code', async () => {
    const party = await create({ name: 'Update Me', roles: ['client'], contacts: [{ name: 'A' }] });
    const updated = await kit.db.transaction((tx) =>
      parties().update(
        party.id,
        { name: 'Updated Name', roles: ['client', 'vendor'], city: 'Lahore', contacts: [] },
        party.version,
        kit.actor,
        tx,
      ),
    );
    expect(updated).toMatchObject({
      code: party.code,
      name: 'Updated Name',
      roles: ['client', 'vendor'],
      city: 'Lahore',
      version: party.version + 1,
      contacts: [],
    });
    expect(await auditCount(kit.db, 'master.party.update')).toBeGreaterThan(0);
  });

  it('leaves the contacts alone when an update does not mention them', async () => {
    const party = await create({ name: 'Keep Contacts', contacts: [{ name: 'Kept' }] });
    const updated = await kit.db.transaction((tx) =>
      parties().update(
        party.id,
        { name: 'Keep Contacts 2', roles: ['vendor'] },
        party.version,
        kit.actor,
        tx,
      ),
    );
    expect(updated.contacts.map((c) => c.name)).toEqual(['Kept']);
    expect((await parties().get(kit.db, party.id)).contacts).toHaveLength(1);
  });

  it('answers 409 for a stale version and 404 for an unknown party', async () => {
    const party = await create({ name: 'Stale Version' });
    const attempt = (version: number, id = party.id) =>
      kit.db.transaction((tx) =>
        parties().update(id, { name: 'X', roles: ['vendor'] }, version, kit.actor, tx),
      );
    expect(await codeOf(attempt(party.version + 5))).toBe('version_conflict');
    expect(await codeOf(attempt(1, uid(9999)))).toBe('party_not_found');
  });

  it('finds parties by name, NTN, CNIC, code and phone with paging and sorting (AC-1)', async () => {
    const party = await create({
      name: 'Searchable Quarry',
      roles: ['vendor'],
      ntn: '9990001-1',
      cnic: '3520299900011',
      phone: '0322 9990001',
      city: 'Attock',
    });
    const search = (q: string, extra = {}) =>
      parties().search(kit.db, {
        q,
        sort: 'name',
        direction: 'asc',
        limit: 50,
        offset: 0,
        ...extra,
      });
    for (const q of [
      'searchable quarry',
      '9990001-1',
      '35202-99900011',
      party.code,
      '322 9990001',
    ]) {
      const result = await search(q);
      expect(result.items.map((p) => p.id)).toContain(party.id);
    }
    expect((await search('100% no_such')).items).toEqual([]);
    const vendors = await search('searchable', { role: 'vendor', status: 'active' });
    expect(vendors).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect((await search('searchable', { role: 'client' })).total).toBe(0);
    const all = await parties().search(kit.db, {
      sort: 'code',
      direction: 'desc',
      limit: 2,
      offset: 1,
    });
    expect(all.items).toHaveLength(2);
    expect(all.total).toBeGreaterThan(2);
    for (const sort of ['city', 'status'] as const) {
      const sorted = await parties().search(kit.db, {
        sort,
        direction: 'asc',
        limit: 5,
        offset: 0,
      });
      expect(sorted.items.length).toBeGreaterThan(0);
    }
    const found = await parties().find(kit.db, party.id);
    expect(found?.id).toBe(party.id);
    expect(await parties().find(kit.db, uid(9998))).toBeUndefined();
    expect(await codeOf(parties().get(kit.db, uid(9998)))).toBe('party_not_found');
  });

  it('soft-deletes an unreferenced party and refuses a referenced one (T-7, BR-8)', async () => {
    const free = await create({ name: 'Delete Me' });
    await kit.db.transaction((tx) => parties().remove(free.id, free.version, kit.actor, tx));
    expect(await parties().find(kit.db, free.id)).toBeUndefined();
    expect(await auditCount(kit.db, 'master.party.delete')).toBeGreaterThan(0);

    const used = await create({ name: 'Referenced Co' });
    kit.masterData.registerReferenceCheck('party', (_db, id) => Promise.resolve(id === used.id));
    expect(
      await codeOf(
        kit.db.transaction((tx) => parties().remove(used.id, used.version, kit.actor, tx)),
      ),
    ).toBe('party_referenced');
    // Setting it inactive is always possible.
    const inactive = await kit.db.transaction((tx) =>
      parties().update(
        used.id,
        { name: 'Referenced Co', roles: ['vendor'], status: 'inactive' },
        used.version,
        kit.actor,
        tx,
      ),
    );
    expect(inactive.status).toBe('inactive');

    const stale = await create({ name: 'Stale Delete' });
    expect(
      await codeOf(
        kit.db.transaction((tx) => parties().remove(stale.id, stale.version + 3, kit.actor, tx)),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(kit.db.transaction((tx) => parties().remove(uid(9997), 1, kit.actor, tx))),
    ).toBe('party_not_found');
  });
});
