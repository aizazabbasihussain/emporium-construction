import { ValidationError } from '@emporium/domain';
import type { Clock } from '@emporium/domain/kernel';
import {
  findDuplicates,
  isHardDuplicate,
  normalizeCnic,
  normalizeName,
  normalizePhone,
  normalizeTaxNumber,
  seriesForRole,
  type DuplicateMatch,
  type PartyIdentity,
} from '@emporium/domain/masterdata';
import { partyRoles, partyStatuses, type PartyRole, type PartyStatus } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertFound,
  assertNoDuplicates,
  assertNotReferenced,
  assertUpdated,
} from '../policy/masterdata.policy.js';
import {
  deleteParty,
  findDuplicateCandidates,
  findParty,
  insertParty,
  listContacts,
  listContactsForParties,
  replaceContacts,
  searchParties,
  updateParty,
  type ContactRow,
  type PartyRow,
  type PartySearch,
} from '../repo/parties.repo.js';
import type { Actor, ContactDto, Db, PageResult, PartyDto } from '../types.js';
import { createRecorder, normalizedOrNull, pageOf, requiredText, textOrNull } from './support.js';
import type { References } from './references.service.js';

export interface ContactInput {
  name: string;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  role?: string | null | undefined;
}

export interface PartyInput {
  name: string;
  legalName?: string | null | undefined;
  roles: readonly string[];
  ntn?: string | null | undefined;
  strn?: string | null | undefined;
  cnic?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
  city?: string | null | undefined;
  status?: string | undefined;
  notes?: string | null | undefined;
  contacts?: readonly ContactInput[] | undefined;
}

export interface DuplicateQuery {
  name: string;
  phone?: string | null | undefined;
  ntn?: string | null | undefined;
  cnic?: string | null | undefined;
  excludeId?: string | undefined;
}

export interface DuplicateInfo extends DuplicateMatch {
  code: string;
  name: string;
  /** NTN and CNIC repeats are refused; name plus phone is a warning the user can confirm. */
  blocking: boolean;
}

export type PartySearchQuery = Omit<PartySearch, 'role' | 'status'> & {
  role?: string | undefined;
  status?: string | undefined;
};

export interface PartiesService {
  create(
    input: PartyInput,
    actor: Actor,
    tx: Db,
    options?: { confirmDuplicate?: boolean },
  ): Promise<PartyDto>;
  update(
    id: string,
    input: PartyInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    options?: { confirmDuplicate?: boolean },
  ): Promise<PartyDto>;
  /** BR-8: soft delete, refused while any document refers to the party. */
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  get(db: Db, id: string): Promise<PartyDto>;
  find(db: Db, id: string): Promise<PartyDto | undefined>;
  search(db: Db, query: PartySearchQuery): Promise<PageResult<PartyDto>>;
  checkDuplicate(db: Db, query: DuplicateQuery): Promise<DuplicateInfo[]>;
}

interface Prepared {
  name: string;
  legalName: string | null;
  roles: PartyRole[];
  ntn: string | null;
  strn: string | null;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  status: PartyStatus;
  notes: string | null;
  /** Undefined leaves the existing contacts as they are. */
  contacts: ContactRow[] | undefined;
}

function parseRoles(roles: readonly string[]): PartyRole[] {
  const known = new Set<string>(partyRoles);
  const unique = [...new Set(roles)];
  if (unique.length === 0 || unique.some((role) => !known.has(role))) {
    throw new ValidationError('invalid_roles', 'Choose at least one valid role');
  }
  return unique as PartyRole[];
}

function parseStatus(status: string | undefined): PartyStatus {
  if (status === undefined) return 'active';
  if (!(partyStatuses as readonly string[]).includes(status)) {
    throw new ValidationError('invalid_status', 'The status must be active or inactive');
  }
  return status as PartyStatus;
}

/** BR-1, BR-3: names are required; CNIC and phone are checked and normalized. */
function prepare(input: PartyInput): Prepared {
  return {
    name: requiredText(input.name, 'name'),
    legalName: textOrNull(input.legalName),
    roles: parseRoles(input.roles),
    ntn: normalizedOrNull(input.ntn, normalizeTaxNumber),
    strn: normalizedOrNull(input.strn, normalizeTaxNumber),
    cnic: normalizedOrNull(input.cnic, normalizeCnic),
    phone: normalizedOrNull(input.phone, normalizePhone),
    email: textOrNull(input.email),
    address: textOrNull(input.address),
    city: textOrNull(input.city),
    status: parseStatus(input.status),
    notes: textOrNull(input.notes),
    contacts: input.contacts?.map((contact) => ({
      name: requiredText(contact.name, 'contact_name'),
      phone: normalizedOrNull(contact.phone, normalizePhone),
      email: textOrNull(contact.email),
      role: textOrNull(contact.role),
    })),
  };
}

const toContactDto = (row: ContactRow): ContactDto => ({
  name: row.name,
  phone: row.phone,
  email: row.email,
  role: row.role,
});

export function toPartyDto(row: PartyRow, contacts: ContactRow[]): PartyDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legal_name,
    roles: row.kind as PartyRole[],
    ntn: row.ntn,
    strn: row.strn,
    cnic: row.cnic,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
    status: row.status as PartyStatus,
    notes: row.notes,
    contacts: contacts.map(toContactDto),
    version: row.version,
  };
}

/** NTN and CNIC are unique among active parties only, so an inactive party never blocks or is blocked. */
const identityOf = (
  row: Pick<PartyRow, 'name' | 'phone' | 'ntn' | 'cnic' | 'status'> & { id?: string | undefined },
): PartyIdentity => {
  const active = row.status === 'active';
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    ntn: active ? row.ntn : null,
    cnic: active ? row.cnic : null,
  };
};

export function createPartiesService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  references: References;
}): PartiesService {
  const { platform, clock, newId, references } = deps;
  const record = createRecorder(platform);

  async function duplicatesOf(
    db: Db,
    candidate: Pick<Prepared, 'name' | 'phone' | 'ntn' | 'cnic' | 'status'>,
    excludeId?: string,
  ): Promise<{ matches: DuplicateMatch[]; rows: Map<string, PartyRow> }> {
    const found = await findDuplicateCandidates(db, {
      nameKey: normalizeName(candidate.name),
      phone: candidate.phone,
      ntn: candidate.ntn,
      cnic: candidate.cnic,
    });
    const rows = new Map(found.map((row) => [row.id, row]));
    const identity = identityOf({ ...candidate, id: excludeId });
    const others = found.map((row) => ({ ...identityOf(row), id: row.id }));
    return { matches: findDuplicates(identity, others), rows };
  }

  const summary = (row: PartyRow) => ({
    code: row.code,
    name: row.name,
    roles: row.kind,
    status: row.status,
  });

  async function dtoOf(db: Db, row: PartyRow): Promise<PartyDto> {
    return toPartyDto(row, await listContacts(db, row.id));
  }

  async function save(
    prepared: Prepared,
    existing: PartyRow | undefined,
    expectedVersion: number | undefined,
    actor: Actor,
    tx: Db,
    options: { confirmDuplicate?: boolean },
  ): Promise<PartyDto> {
    const { matches } = await duplicatesOf(tx, prepared, existing?.id);
    assertNoDuplicates(matches, options.confirmDuplicate === true);
    const now = clock.now();
    const values = {
      name: prepared.name,
      legal_name: prepared.legalName,
      kind: { json: prepared.roles },
      ntn: prepared.ntn,
      strn: prepared.strn,
      cnic: prepared.cnic,
      phone: prepared.phone,
      email: prepared.email,
      address: prepared.address,
      city: prepared.city,
      status: prepared.status,
      notes: prepared.notes,
    };
    let row: PartyRow;
    if (existing === undefined) {
      const code = await platform.numbering.next(seriesForRole(prepared.roles[0] as string), tx);
      row = await insertParty(tx, { id: newId(), code, ...values }, actor.userId, now);
    } else {
      row = assertUpdated(
        await updateParty(tx, existing.id, expectedVersion as number, values, actor.userId, now),
      );
    }
    let contacts = prepared.contacts;
    if (contacts === undefined) {
      contacts = existing === undefined ? [] : await listContacts(tx, row.id);
    } else {
      await replaceContacts(
        tx,
        row.id,
        contacts.map((contact) => ({ id: newId(), ...contact })),
        now,
      );
    }
    await record(tx, actor, {
      action: existing === undefined ? 'master.party.create' : 'master.party.update',
      entityType: 'master_party',
      entityId: row.id,
      before: existing === undefined ? undefined : summary(existing),
      after: summary(row),
      event: {
        type: 'master.party.changed',
        payload: {
          partyId: row.id,
          code: row.code,
          change: existing === undefined ? 'created' : 'updated',
        },
      },
    });
    return toPartyDto(row, contacts);
  }

  return {
    create: (input, actor, tx, options = {}) =>
      save(prepare(input), undefined, undefined, actor, tx, options),

    async update(id, input, expectedVersion, actor, tx, options = {}) {
      const existing = assertFound(await findParty(tx, id, true), 'party');
      return save(prepare(input), existing, expectedVersion, actor, tx, options);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findParty(tx, id, true), 'party');
      assertNotReferenced(await references.isReferenced(tx, 'party', id), 'party');
      assertApplied(await deleteParty(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.party.delete',
        entityType: 'master_party',
        entityId: id,
        before: summary(existing),
        event: {
          type: 'master.party.changed',
          payload: { partyId: id, code: existing.code, change: 'deleted' },
        },
      });
    },

    async get(db, id) {
      return dtoOf(db, assertFound(await findParty(db, id), 'party'));
    },

    async find(db, id) {
      const row = await findParty(db, id);
      return row === undefined ? undefined : dtoOf(db, row);
    },

    async search(db, query) {
      const { rows, total } = await searchParties(db, query);
      const contacts = await listContactsForParties(
        db,
        rows.map((row) => row.id),
      );
      return pageOf(
        rows.map((row) => toPartyDto(row, contacts.get(row.id) ?? [])),
        total,
        query,
      );
    },

    async checkDuplicate(db, query) {
      const candidate = {
        name: requiredText(query.name, 'name'),
        phone: normalizedOrNull(query.phone, normalizePhone),
        ntn: normalizedOrNull(query.ntn, normalizeTaxNumber),
        cnic: normalizedOrNull(query.cnic, normalizeCnic),
        status: 'active' as const,
      };
      const { matches, rows } = await duplicatesOf(db, candidate, query.excludeId);
      return matches.map((match) => {
        const row = rows.get(match.id) as PartyRow;
        return {
          ...match,
          code: row.code,
          name: row.name,
          blocking: isHardDuplicate(match),
        };
      });
    },
  };
}
