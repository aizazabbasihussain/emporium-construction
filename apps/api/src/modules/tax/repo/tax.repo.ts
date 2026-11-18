import type { TaxRuleKind } from '@emporium/shared';
import type { Db } from '../types.js';

// SQL access for the tax module. No business rules here (constitution 3). Rates are read as text
// so no float ever appears; dates are cast to text for the same reason.

export interface AuthorityRow {
  code: string;
  name: string;
  registration_type: string;
}

interface DecisionColumns {
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  status: string;
  requested_by: string | null;
  approved_by: string | null;
}

export interface RegionMapRow extends DecisionColumns {
  id: string;
  region: string;
  supply_kind: string;
  authority_code: string;
}

export interface SalesRuleRow extends DecisionColumns {
  id: string;
  authority_code: string;
  supply_kind: string;
  nature: string | null;
  rate_percent: string;
  tax_code: string;
}

export interface WithholdingRuleRow extends DecisionColumns {
  id: string;
  direction: string;
  authority_code: string;
  party_type: string | null;
  nature: string;
  rate_percent: string;
  base: string;
}

export type AnyRuleRow = RegionMapRow | SalesRuleRow | WithholdingRuleRow;

const DATES = `to_char(effective_from, 'YYYY-MM-DD') as effective_from,
  to_char(effective_to, 'YYYY-MM-DD') as effective_to, note, status, requested_by, approved_by`;

const TABLES: Record<TaxRuleKind, { table: string; columns: string }> = {
  region: {
    table: 'tax_region_map',
    columns: `id, region, supply_kind, authority_code, ${DATES}`,
  },
  sales: {
    table: 'tax_rules',
    columns: `id, authority_code, supply_kind, nature, rate_percent::text as rate_percent, tax_code, ${DATES}`,
  },
  withholding: {
    table: 'tax_withholding_rules',
    columns: `id, direction, authority_code, party_type, nature, rate_percent::text as rate_percent, base, ${DATES}`,
  },
};

export const listAuthorities = (db: Db) =>
  db.query<AuthorityRow>('select code, name, registration_type from tax_authorities order by code');

export const listSettings = (db: Db) =>
  db.query<{ key: string; value: string }>('select key, value from tax_settings');

/** Rules of one kind, newest start first; `status` narrows to one status. */
export const listRules = <T extends AnyRuleRow>(db: Db, kind: TaxRuleKind, status?: string) =>
  db.query<T>(
    `select ${TABLES[kind].columns} from ${TABLES[kind].table}
      where ($1::text is null or status = $1)
      order by effective_from desc, created_at desc, id`,
    [status ?? null],
  );

export async function findRule<T extends AnyRuleRow>(
  db: Db,
  kind: TaxRuleKind,
  id: string,
  lock = false,
): Promise<T | undefined> {
  const rows = await db.query<T>(
    `select ${TABLES[kind].columns} from ${TABLES[kind].table} where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

interface Common {
  id: string;
  authorityCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  requestedBy: string;
  at: Date;
}

export async function insertRegionEntry(
  db: Db,
  rule: Common & { region: string; supplyKind: string },
): Promise<RegionMapRow> {
  const rows = await db.query<RegionMapRow>(
    `insert into tax_region_map (id, region, supply_kind, authority_code, effective_from, effective_to,
        note, status, requested_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, $9)
     returning ${TABLES.region.columns}`,
    [
      rule.id,
      rule.region,
      rule.supplyKind,
      rule.authorityCode,
      rule.effectiveFrom,
      rule.effectiveTo,
      rule.note,
      rule.requestedBy,
      rule.at.toISOString(),
    ],
  );
  return rows[0] as RegionMapRow;
}

export async function insertSalesRule(
  db: Db,
  rule: Common & {
    supplyKind: string;
    nature: string | null;
    ratePercent: string;
    taxCode: string;
  },
): Promise<SalesRuleRow> {
  const rows = await db.query<SalesRuleRow>(
    `insert into tax_rules (id, authority_code, supply_kind, nature, rate_percent, tax_code,
        effective_from, effective_to, note, status, requested_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval', $10, $11)
     returning ${TABLES.sales.columns}`,
    [
      rule.id,
      rule.authorityCode,
      rule.supplyKind,
      rule.nature,
      rule.ratePercent,
      rule.taxCode,
      rule.effectiveFrom,
      rule.effectiveTo,
      rule.note,
      rule.requestedBy,
      rule.at.toISOString(),
    ],
  );
  return rows[0] as SalesRuleRow;
}

export async function insertWithholdingRule(
  db: Db,
  rule: Common & {
    direction: string;
    partyType: string | null;
    nature: string;
    ratePercent: string;
    base: string;
  },
): Promise<WithholdingRuleRow> {
  const rows = await db.query<WithholdingRuleRow>(
    `insert into tax_withholding_rules (id, direction, authority_code, party_type, nature, rate_percent,
        base, effective_from, effective_to, note, status, requested_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_approval', $11, $12)
     returning ${TABLES.withholding.columns}`,
    [
      rule.id,
      rule.direction,
      rule.authorityCode,
      rule.partyType,
      rule.nature,
      rule.ratePercent,
      rule.base,
      rule.effectiveFrom,
      rule.effectiveTo,
      rule.note,
      rule.requestedBy,
      rule.at.toISOString(),
    ],
  );
  return rows[0] as WithholdingRuleRow;
}

export const decideRule = (
  db: Db,
  kind: TaxRuleKind,
  id: string,
  decision: { status: 'active' | 'rejected'; approvedBy: string | null },
) =>
  db.query(`update ${TABLES[kind].table} set status = $2, approved_by = $3 where id = $1`, [
    id,
    decision.status,
    decision.approvedBy,
  ]);

/** BR-5: a successor closes its predecessor the day before it starts. */
export const closeRule = (db: Db, kind: TaxRuleKind, id: string, effectiveTo: string) =>
  db.query(`update ${TABLES[kind].table} set effective_to = $2 where id = $1`, [id, effectiveTo]);
