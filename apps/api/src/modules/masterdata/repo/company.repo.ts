import type { Db } from '../types.js';
import { findRow, insertRow, softDeleteRow, updateRow, type Values } from './crud.js';

const COMPANY_COLUMNS = 'id, name, address, phone, email, logo_file_id, version';
export interface CompanyRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logo_file_id: string | null;
  version: number;
}

export async function getCompany(db: Db): Promise<CompanyRow | undefined> {
  const rows = await db.query<CompanyRow>(
    `select ${COMPANY_COLUMNS} from mst_company where deleted_at is null limit 1`,
  );
  return rows[0];
}

export const insertCompany = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CompanyRow>(db, 'mst_company', COMPANY_COLUMNS, values, by, at);

export const updateCompany = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<CompanyRow>(
    db,
    'mst_company',
    COMPANY_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

const REGISTRATION_COLUMNS = `id, authority, registration_type, number,
  to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, version`;
export interface RegistrationRow {
  id: string;
  authority: string;
  registration_type: string;
  number: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
}

export const listRegistrations = (db: Db) =>
  db.query<RegistrationRow>(
    `select ${REGISTRATION_COLUMNS} from mst_tax_registrations
      where deleted_at is null order by authority, registration_type, valid_from`,
  );

export const findRegistration = (db: Db, id: string, lock = false) =>
  findRow<RegistrationRow>(
    db,
    'mst_tax_registrations',
    REGISTRATION_COLUMNS,
    { column: 'id', value: id },
    lock,
  );

/** Registrations of one (authority, type), for the overlap rule (BR-7). */
export const listRegistrationsOfKind = (db: Db, authority: string, type: string) =>
  db.query<RegistrationRow>(
    `select ${REGISTRATION_COLUMNS} from mst_tax_registrations
      where authority = $1 and registration_type = $2 and deleted_at is null`,
    [authority, type],
  );

export const listRegistrationsOfAuthority = (db: Db, authority: string) =>
  db.query<RegistrationRow>(
    `select ${REGISTRATION_COLUMNS} from mst_tax_registrations
      where authority = $1 and deleted_at is null order by registration_type`,
    [authority],
  );

export const insertRegistration = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<RegistrationRow>(db, 'mst_tax_registrations', REGISTRATION_COLUMNS, values, by, at);

export const updateRegistration = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<RegistrationRow>(
    db,
    'mst_tax_registrations',
    REGISTRATION_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const deleteRegistration = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_tax_registrations', { column: 'id', value: id }, version, by, at);

const LOCATION_COLUMNS = 'id, name, region, city, version';
export interface LocationRow {
  id: string;
  name: string;
  region: string;
  city: string;
  version: number;
}

export const listLocations = (db: Db, region?: string) =>
  db.query<LocationRow>(
    `select ${LOCATION_COLUMNS} from mst_locations
      where deleted_at is null and ($1::text is null or region = $1)
      order by region, city, name`,
    [region ?? null],
  );

export const findLocation = (db: Db, id: string, lock = false) =>
  findRow<LocationRow>(db, 'mst_locations', LOCATION_COLUMNS, { column: 'id', value: id }, lock);

export const insertLocation = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<LocationRow>(db, 'mst_locations', LOCATION_COLUMNS, values, by, at);

export const updateLocation = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<LocationRow>(
    db,
    'mst_locations',
    LOCATION_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const deleteLocation = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_locations', { column: 'id', value: id }, version, by, at);
