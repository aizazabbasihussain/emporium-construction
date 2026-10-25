import type { Db } from '../types.js';
import {
  countOf,
  findRow,
  insertRow,
  likePattern,
  softDeleteRow,
  updateRow,
  type Values,
} from './crud.js';

const PARTY_COLUMNS = `id, code, name, legal_name, kind, ntn, strn, cnic, phone, email,
  address, city, status, notes, version`;

export interface PartyRow {
  id: string;
  code: string;
  name: string;
  legal_name: string | null;
  kind: string[];
  ntn: string | null;
  strn: string | null;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  status: string;
  notes: string | null;
  version: number;
}

export interface ContactRow {
  name: string;
  phone: string | null;
  email: string | null;
  role: string | null;
}

export const insertParty = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<PartyRow>(db, 'mst_parties', PARTY_COLUMNS, values, by, at);

export const updateParty = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<PartyRow>(
    db,
    'mst_parties',
    PARTY_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const findParty = (db: Db, id: string, lock = false) =>
  findRow<PartyRow>(db, 'mst_parties', PARTY_COLUMNS, { column: 'id', value: id }, lock);

export async function findPartyByCode(db: Db, code: string): Promise<PartyRow | undefined> {
  const rows = await db.query<PartyRow>(
    `select ${PARTY_COLUMNS} from mst_parties where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export const deleteParty = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_parties', { column: 'id', value: id }, version, by, at);

export async function replaceContacts(
  db: Db,
  partyId: string,
  contacts: readonly (ContactRow & { id: string })[],
  at: Date,
): Promise<void> {
  await db.query('delete from mst_party_contacts where party_id = $1', [partyId]);
  for (const contact of contacts) {
    await db.query(
      `insert into mst_party_contacts (id, party_id, name, phone, email, role, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        contact.id,
        partyId,
        contact.name,
        contact.phone,
        contact.email,
        contact.role,
        at.toISOString(),
      ],
    );
  }
}

export const listContacts = (db: Db, partyId: string) =>
  db.query<ContactRow>(
    `select name, phone, email, role from mst_party_contacts
      where party_id = $1 order by created_at, id`,
    [partyId],
  );

export async function listContactsForParties(
  db: Db,
  partyIds: readonly string[],
): Promise<Map<string, ContactRow[]>> {
  const grouped = new Map<string, ContactRow[]>();
  if (partyIds.length === 0) return grouped;
  const rows = await db.query<ContactRow & { party_id: string }>(
    `select party_id, name, phone, email, role from mst_party_contacts
      where party_id = any($1::uuid[]) order by created_at, id`,
    [partyIds],
  );
  for (const { party_id: partyId, ...contact } of rows) {
    grouped.set(partyId, [...(grouped.get(partyId) ?? []), contact]);
  }
  return grouped;
}

export interface PartySearch {
  q?: string | undefined;
  role?: string | undefined;
  status?: string | undefined;
  sort: 'code' | 'name' | 'city' | 'status';
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const SORT_COLUMNS: Record<PartySearch['sort'], string> = {
  code: 'code',
  name: 'lower(name)',
  city: 'lower(city)',
  status: 'status',
};

/** Matches name, legal name, code, NTN, CNIC digits or phone (AC-1). */
export async function searchParties(
  db: Db,
  search: PartySearch,
): Promise<{ rows: PartyRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.q !== undefined) {
    const text = add(likePattern(search.q));
    const clauses = [
      `name ilike ${text}`,
      `legal_name ilike ${text}`,
      `code ilike ${text}`,
      `ntn ilike ${text}`,
    ];
    const digits = search.q.replace(/\D/g, '');
    if (digits !== '') {
      const pattern = add(`%${digits}%`);
      clauses.push(`cnic like ${pattern}`, `phone like ${pattern}`);
    }
    where.push(`(${clauses.join(' or ')})`);
  }
  if (search.role !== undefined) where.push(`kind @> ${add(JSON.stringify([search.role]))}::jsonb`);
  if (search.status !== undefined) where.push(`status = ${add(search.status)}`);
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from mst_parties where ${clause}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<PartyRow>(
    `select ${PARTY_COLUMNS} from mst_parties where ${clause}
      order by ${SORT_COLUMNS[search.sort]} ${search.direction === 'desc' ? 'desc' : 'asc'}, id
      limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: countOf(total) };
}

export interface DuplicateKeys {
  nameKey: string;
  phone: string | null;
  ntn: string | null;
  cnic: string | null;
}

/** Parties that could repeat the given identity (BR-2); the domain decides which ones do. */
export const findDuplicateCandidates = (db: Db, keys: DuplicateKeys) =>
  db.query<PartyRow>(
    `select ${PARTY_COLUMNS} from mst_parties
      where deleted_at is null
        and (($1::text is not null and phone = $1
              and lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $2)
          or ($3::text is not null and ntn = $3)
          or ($4::text is not null and cnic = $4))`,
    [keys.phone, keys.nameKey, keys.ntn, keys.cnic],
  );
