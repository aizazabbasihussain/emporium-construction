import { RuleViolationError } from '../errors.js';
import { inRange, type DateRange } from './ranges.js';

export interface RegionMapEntry extends DateRange {
  id: string;
  region: string;
  supplyKind: string;
  authorityCode: string;
}

/** BR-1: the authority for a region and supply kind on a date; no mapping blocks the document. */
export function resolveAuthority(
  map: readonly RegionMapEntry[],
  query: { region: string; supplyKind: string; date: string },
): string {
  const found = map.filter(
    (entry) =>
      entry.region === query.region &&
      entry.supplyKind === query.supplyKind &&
      inRange(entry, query.date),
  );
  const only = found[0];
  if (only === undefined) {
    throw new RuleViolationError(
      'tax_authority_unmapped',
      `No tax authority is mapped for ${query.supplyKind} in ${query.region} on ${query.date}`,
    );
  }
  if (found.length > 1) {
    throw new RuleViolationError(
      'tax_authority_ambiguous',
      `More than one tax authority is mapped for ${query.supplyKind} in ${query.region} on ${query.date}`,
    );
  }
  return only.authorityCode;
}

export interface SalesRuleRef extends DateRange {
  id: string;
  authorityCode: string;
  supplyKind: string;
  nature: string | null;
  taxCode: string;
  ratePercent: string;
}

/**
 * BR-2: the single active rule for the authority, supply kind and nature on the date, falling back
 * to the rule without a nature. No match and several matches are both errors, and the message
 * names what is missing (BR-9).
 */
export function selectRule<T extends SalesRuleRef>(
  rules: readonly T[],
  query: { authorityCode: string; supplyKind: string; nature: string | null; date: string },
): T {
  const active = rules.filter(
    (rule) =>
      rule.authorityCode === query.authorityCode &&
      rule.supplyKind === query.supplyKind &&
      inRange(rule, query.date),
  );
  const exact = query.nature === null ? [] : active.filter((rule) => rule.nature === query.nature);
  const pool = exact.length > 0 ? exact : active.filter((rule) => rule.nature === null);
  const what = `${query.authorityCode} ${query.supplyKind}${query.nature === null ? '' : ` (${query.nature})`} on ${query.date}`;
  const only = pool[0];
  if (only === undefined) {
    throw new RuleViolationError('tax_rule_missing', `No active sales tax rule for ${what}`);
  }
  if (pool.length > 1) {
    throw new RuleViolationError('tax_rule_ambiguous', `More than one sales tax rule for ${what}`);
  }
  return only;
}
