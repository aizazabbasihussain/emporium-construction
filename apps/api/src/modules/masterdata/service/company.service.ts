import { ConflictError, ValidationError } from '@emporium/domain';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  assertNoRegistrationOverlap,
  assertValidRange,
  isInForce,
  normalizeAuthority,
  normalizePhone,
} from '@emporium/domain/masterdata';
import { regions, registrationTypes, type Region, type RegistrationType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import { assertApplied, assertFound, assertUpdated } from '../policy/masterdata.policy.js';
import {
  deleteLocation,
  deleteRegistration,
  findLocation,
  findRegistration,
  getCompany,
  insertCompany,
  insertLocation,
  insertRegistration,
  listLocations,
  listRegistrations,
  listRegistrationsOfAuthority,
  listRegistrationsOfKind,
  updateCompany,
  updateLocation,
  updateRegistration,
  type CompanyRow,
  type LocationRow,
  type RegistrationRow,
} from '../repo/company.repo.js';
import type { Actor, CompanyDto, Db, LocationDto, RegistrationDto } from '../types.js';
import { createRecorder, normalizedOrNull, requiredText, textOrNull } from './support.js';

const companyDto = (row: CompanyRow): CompanyDto => ({
  id: row.id,
  name: row.name,
  address: row.address,
  phone: row.phone,
  email: row.email,
  logoFileId: row.logo_file_id,
  version: row.version,
});

const registrationDto = (row: RegistrationRow): RegistrationDto => ({
  id: row.id,
  authority: row.authority,
  registrationType: row.registration_type as RegistrationType,
  number: row.number,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  version: row.version,
});

const locationDto = (row: LocationRow): LocationDto => ({
  id: row.id,
  name: row.name,
  region: row.region as Region,
  city: row.city,
  version: row.version,
});

const range = (row: RegistrationRow) => ({
  id: row.id,
  validFrom: row.valid_from,
  validTo: row.valid_to,
});

export interface CompanyInput {
  name: string;
  address?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  logoFileId?: string | null | undefined;
}

export interface RegistrationInput {
  authority: string;
  registrationType: string;
  number: string;
  validFrom: string;
  validTo?: string | null | undefined;
}

export interface LocationInput {
  name: string;
  region: string;
  city: string;
}

export interface CompanyService {
  /** Null until the owner enters the profile. */
  getCompany(db: Db): Promise<CompanyDto | null>;
  /** The profile is one row: the first save creates it, later saves need its version. */
  saveCompany(
    input: CompanyInput,
    expectedVersion: number | undefined,
    actor: Actor,
    tx: Db,
  ): Promise<CompanyDto>;

  listRegistrations(db: Db): Promise<RegistrationDto[]>;
  createRegistration(input: RegistrationInput, actor: Actor, tx: Db): Promise<RegistrationDto>;
  updateRegistration(
    id: string,
    input: RegistrationInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<RegistrationDto>;
  removeRegistration(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /**
   * BR-7: the registration in force on `date` (default today) for the authority, or null. When
   * several types are in force, the first of ntn, strn, pra, other is returned unless `type` is given.
   */
  getRegistration(
    db: Db,
    authority: string,
    options?: { date?: string; type?: string },
  ): Promise<RegistrationDto | null>;

  listLocations(db: Db, region?: string): Promise<LocationDto[]>;
  createLocation(input: LocationInput, actor: Actor, tx: Db): Promise<LocationDto>;
  updateLocation(
    id: string,
    input: LocationInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<LocationDto>;
  removeLocation(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
}

export function createCompanyService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
}): CompanyService {
  const { platform, clock, newId } = deps;
  const record = createRecorder(platform);

  async function registrationValues(tx: Db, input: RegistrationInput, selfId: string) {
    const authority = normalizeAuthority(input.authority);
    if (!(registrationTypes as readonly string[]).includes(input.registrationType)) {
      throw new ValidationError('invalid_registration_type', 'Unknown registration type');
    }
    const validTo = input.validTo ?? null;
    const dates = { validFrom: input.validFrom, validTo };
    assertValidRange(dates);
    BusinessDate.parse(input.validFrom);
    if (validTo !== null) BusinessDate.parse(validTo);
    const same = await listRegistrationsOfKind(tx, authority, input.registrationType);
    assertNoRegistrationOverlap({ id: selfId, ...dates }, same.map(range));
    return {
      authority,
      registration_type: input.registrationType,
      number: requiredText(input.number, 'number'),
      valid_from: input.validFrom,
      valid_to: validTo,
    };
  }

  function locationValues(input: LocationInput) {
    if (!(regions as readonly string[]).includes(input.region)) {
      throw new ValidationError('invalid_region', 'The region must be islamabad or punjab');
    }
    return {
      name: requiredText(input.name, 'name'),
      region: input.region,
      city: requiredText(input.city, 'city'),
    };
  }

  return {
    async getCompany(db) {
      const row = await getCompany(db);
      return row === undefined ? null : companyDto(row);
    },

    async saveCompany(input, expectedVersion, actor, tx) {
      const existing = await getCompany(tx);
      const values = {
        name: requiredText(input.name, 'name'),
        address: textOrNull(input.address),
        phone: normalizedOrNull(input.phone, normalizePhone),
        email: textOrNull(input.email),
        logo_file_id: input.logoFileId ?? null,
      };
      let row: CompanyRow;
      if (existing === undefined) {
        row = await insertCompany(tx, { id: newId(), ...values }, actor.userId, clock.now());
      } else {
        if (expectedVersion === undefined) {
          throw new ConflictError(
            'version_required',
            'The company profile exists: send its version',
          );
        }
        row = assertUpdated(
          await updateCompany(tx, existing.id, expectedVersion, values, actor.userId, clock.now()),
        );
      }
      await record(tx, actor, {
        action: 'master.company.save',
        entityType: 'master_company',
        entityId: row.id,
        before: existing === undefined ? undefined : companyDto(existing),
        after: companyDto(row),
      });
      return companyDto(row);
    },

    listRegistrations: async (db) => (await listRegistrations(db)).map(registrationDto),

    async createRegistration(input, actor, tx) {
      const id = newId();
      const values = await registrationValues(tx, input, id);
      const row = await insertRegistration(tx, { id, ...values }, actor.userId, clock.now());
      await record(tx, actor, {
        action: 'master.registration.create',
        entityType: 'master_tax_registration',
        entityId: id,
        after: { authority: row.authority, type: row.registration_type },
      });
      return registrationDto(row);
    },

    async updateRegistration(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findRegistration(tx, id, true), 'registration');
      const values = await registrationValues(tx, input, id);
      const row = assertUpdated(
        await updateRegistration(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'master.registration.update',
        entityType: 'master_tax_registration',
        entityId: id,
        before: { authority: existing.authority, type: existing.registration_type },
        after: { authority: row.authority, type: row.registration_type },
      });
      return registrationDto(row);
    },

    async removeRegistration(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findRegistration(tx, id, true), 'registration');
      assertApplied(await deleteRegistration(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.registration.delete',
        entityType: 'master_tax_registration',
        entityId: id,
        before: { authority: existing.authority, type: existing.registration_type },
      });
    },

    async getRegistration(db, authority, options = {}) {
      const date = options.date ?? BusinessDate.today(clock).toString();
      const rows = await listRegistrationsOfAuthority(db, normalizeAuthority(authority));
      const active = rows
        .filter((row) => isInForce(range(row), date))
        .filter((row) => options.type === undefined || row.registration_type === options.type)
        .sort(
          (a, b) =>
            registrationTypes.indexOf(a.registration_type as RegistrationType) -
            registrationTypes.indexOf(b.registration_type as RegistrationType),
        );
      const found = active[0];
      return found === undefined ? null : registrationDto(found);
    },

    listLocations: async (db, region) => (await listLocations(db, region)).map(locationDto),

    async createLocation(input, actor, tx) {
      const id = newId();
      const row = await insertLocation(
        tx,
        { id, ...locationValues(input) },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'master.location.create',
        entityType: 'master_location',
        entityId: id,
        after: locationDto(row),
      });
      return locationDto(row);
    },

    async updateLocation(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findLocation(tx, id, true), 'location');
      const row = assertUpdated(
        await updateLocation(
          tx,
          id,
          expectedVersion,
          locationValues(input),
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'master.location.update',
        entityType: 'master_location',
        entityId: id,
        before: locationDto(existing),
        after: locationDto(row),
      });
      return locationDto(row);
    },

    async removeLocation(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findLocation(tx, id, true), 'location');
      assertApplied(await deleteLocation(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.location.delete',
        entityType: 'master_location',
        entityId: id,
        before: locationDto(existing),
      });
    },
  };
}
