import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMasterKit, uid, type MasterKit } from '../test-support.js';
import type { RegistrationInput } from './company.service.js';

let kit: MasterKit;
const company = () => kit.masterData.company;
const tx = <T>(fn: (db: MasterKit['db']) => Promise<T>) => kit.db.transaction(fn);

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

describe('company profile', () => {
  it('is empty until saved, then creates once and updates with a version', async () => {
    expect(await company().getCompany(kit.db)).toBeNull();
    const first = await tx((t) =>
      company().saveCompany(
        { name: ' Example Construction ', phone: '051-1234567', address: ' Islamabad ', email: '' },
        undefined,
        kit.actor,
        t,
      ),
    );
    expect(first).toMatchObject({
      name: 'Example Construction',
      phone: '+92511234567',
      address: 'Islamabad',
      email: null,
      logoFileId: null,
      version: 1,
    });
    expect(await company().getCompany(kit.db)).toEqual(first);
    expect(
      await codeOf(tx((t) => company().saveCompany({ name: 'Again' }, undefined, kit.actor, t))),
    ).toBe('version_required');
    expect(await codeOf(tx((t) => company().saveCompany({ name: 'Again' }, 7, kit.actor, t)))).toBe(
      'version_conflict',
    );
    const logo = uid(9301);
    const second = await tx((t) =>
      company().saveCompany({ name: 'Renamed', logoFileId: logo }, 1, kit.actor, t),
    );
    expect(second).toMatchObject({ name: 'Renamed', logoFileId: logo, version: 2 });
  });

  it('rejects a missing name and a bad phone', async () => {
    expect(await codeOf(tx((t) => company().saveCompany({ name: ' ' }, 2, kit.actor, t)))).toBe(
      'name_required',
    );
    expect(
      await codeOf(tx((t) => company().saveCompany({ name: 'X', phone: 'abc' }, 2, kit.actor, t))),
    ).toBe('invalid_phone');
  });
});

describe('tax registrations (AC-4, T-6, BR-7)', () => {
  const registration = (over: Partial<RegistrationInput> = {}): RegistrationInput => ({
    authority: 'fbr',
    registrationType: 'ntn',
    number: 'SYNTHETIC-0001',
    validFrom: '2025-01-01',
    ...over,
  });

  it('stores a registration per authority and returns the one in force on a date', async () => {
    expect(await company().getRegistration(kit.db, 'FBR')).toBeNull();
    const old = await tx((t) =>
      company().createRegistration(
        registration({ number: 'OLD-1', validTo: '2025-12-31' }),
        kit.actor,
        t,
      ),
    );
    const current = await tx((t) =>
      company().createRegistration(
        registration({ number: 'NEW-1', validFrom: '2026-01-01' }),
        kit.actor,
        t,
      ),
    );
    expect(old.authority).toBe('FBR');
    expect((await company().getRegistration(kit.db, 'fbr', { date: '2025-06-01' }))?.number).toBe(
      'OLD-1',
    );
    // Today in the test clock is 2026-10-25.
    expect((await company().getRegistration(kit.db, 'FBR'))?.id).toBe(current.id);
    expect(await company().getRegistration(kit.db, 'FBR', { date: '2024-01-01' })).toBeNull();
    expect(await company().getRegistration(kit.db, 'PRA')).toBeNull();
    expect((await company().listRegistrations(kit.db)).map((r) => r.number)).toEqual([
      'OLD-1',
      'NEW-1',
    ]);
  });

  it('prefers ntn, then strn, and filters by type', async () => {
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'PRA', registrationType: 'pra', number: 'P-1' }),
        kit.actor,
        t,
      ),
    );
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'PRA', registrationType: 'strn', number: 'S-1' }),
        kit.actor,
        t,
      ),
    );
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'PRA', registrationType: 'other', number: 'O-1' }),
        kit.actor,
        t,
      ),
    );
    expect((await company().getRegistration(kit.db, 'PRA'))?.number).toBe('S-1');
    expect((await company().getRegistration(kit.db, 'PRA', { type: 'pra' }))?.number).toBe('P-1');
    expect((await company().getRegistration(kit.db, 'PRA', { type: 'other' }))?.number).toBe('O-1');
    expect(await company().getRegistration(kit.db, 'PRA', { type: 'ntn' })).toBeNull();
  });

  it('rejects an overlapping registration of the same type but allows it for another type', async () => {
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'XYZ', number: 'X-1', validTo: '2026-06-30' }),
        kit.actor,
        t,
      ),
    );
    expect(
      await codeOf(
        tx((t) =>
          company().createRegistration(
            registration({ authority: 'XYZ', number: 'X-2', validFrom: '2026-06-30' }),
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('registration_overlap');
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'XYZ', registrationType: 'strn', number: 'X-3' }),
        kit.actor,
        t,
      ),
    );
    await tx((t) =>
      company().createRegistration(
        registration({ authority: 'XYZ', number: 'X-4', validFrom: '2026-07-01' }),
        kit.actor,
        t,
      ),
    );
  });

  it('updates and removes with version checks', async () => {
    const created = await tx((t) =>
      company().createRegistration(registration({ authority: 'UPD', number: 'U-1' }), kit.actor, t),
    );
    const updated = await tx((t) =>
      company().updateRegistration(
        created.id,
        registration({ authority: 'UPD', number: 'U-2' }),
        1,
        kit.actor,
        t,
      ),
    );
    expect(updated).toMatchObject({ number: 'U-2', version: 2 });
    expect(
      await codeOf(
        tx((t) =>
          company().updateRegistration(
            created.id,
            registration({ authority: 'UPD' }),
            1,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(
        tx((t) => company().updateRegistration(uid(9302), registration(), 1, kit.actor, t)),
      ),
    ).toBe('registration_not_found');
    expect(await codeOf(tx((t) => company().removeRegistration(created.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
    await tx((t) => company().removeRegistration(created.id, 2, kit.actor, t));
    expect(await codeOf(tx((t) => company().removeRegistration(created.id, 2, kit.actor, t)))).toBe(
      'registration_not_found',
    );
  });

  it.each([
    ['authority', { authority: '1' }, 'invalid_authority'],
    ['type', { registrationType: 'xyz' }, 'invalid_registration_type'],
    ['range', { validFrom: '2026-02-01', validTo: '2026-01-01' }, 'invalid_date_range'],
    ['start date', { validFrom: '2026-02-30' }, 'invalid_date'],
    ['end date', { validTo: '2026-13-01' }, 'invalid_date'],
    ['number', { authority: 'NUM', number: ' ' }, 'number_required'],
  ])('rejects an invalid %s', async (_label, over, code) => {
    expect(
      await codeOf(tx((t) => company().createRegistration(registration(over), kit.actor, t))),
    ).toBe(code);
  });
});

describe('locations', () => {
  it('creates, lists by region, updates and removes', async () => {
    const isb = await tx((t) =>
      company().createLocation(
        { name: 'Head office', region: 'islamabad', city: 'Islamabad' },
        kit.actor,
        t,
      ),
    );
    await tx((t) =>
      company().createLocation(
        { name: 'Lahore yard', region: 'punjab', city: 'Lahore' },
        kit.actor,
        t,
      ),
    );
    expect((await company().listLocations(kit.db)).map((l) => l.region)).toEqual([
      'islamabad',
      'punjab',
    ]);
    expect((await company().listLocations(kit.db, 'punjab')).map((l) => l.name)).toEqual([
      'Lahore yard',
    ]);
    const moved = await tx((t) =>
      company().updateLocation(
        isb.id,
        { name: 'Main office', region: 'islamabad', city: 'Islamabad' },
        1,
        kit.actor,
        t,
      ),
    );
    expect(moved).toMatchObject({ name: 'Main office', version: 2 });
    expect(
      await codeOf(
        tx((t) =>
          company().updateLocation(
            isb.id,
            { name: 'X', region: 'punjab', city: 'Y' },
            1,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(
        tx((t) =>
          company().updateLocation(
            uid(9303),
            { name: 'X', region: 'punjab', city: 'Y' },
            1,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('location_not_found');
    expect(await codeOf(tx((t) => company().removeLocation(isb.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
    await tx((t) => company().removeLocation(isb.id, 2, kit.actor, t));
    expect(await codeOf(tx((t) => company().removeLocation(isb.id, 2, kit.actor, t)))).toBe(
      'location_not_found',
    );
  });

  it('rejects an unknown region and empty text', async () => {
    expect(
      await codeOf(
        tx((t) =>
          company().createLocation({ name: 'X', region: 'sindh', city: 'Y' }, kit.actor, t),
        ),
      ),
    ).toBe('invalid_region');
    expect(
      await codeOf(
        tx((t) =>
          company().createLocation({ name: ' ', region: 'punjab', city: 'Y' }, kit.actor, t),
        ),
      ),
    ).toBe('name_required');
    expect(
      await codeOf(
        tx((t) =>
          company().createLocation({ name: 'X', region: 'punjab', city: ' ' }, kit.actor, t),
        ),
      ),
    ).toBe('city_required');
  });
});
