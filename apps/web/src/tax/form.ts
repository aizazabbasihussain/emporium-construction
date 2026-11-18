// Field checks for the rule request forms. They only save a round trip: the API checks every rule
// again (spec P2-01 BR-2, BR-5).

export type RuleFormError =
  | 'authorityRequired'
  | 'dateRequired'
  | 'rangeInvalid'
  | 'rateRequired'
  | 'rateInvalid'
  | 'rateTooHigh'
  | 'taxCodeRequired'
  | 'natureRequired';

const RATE = /^\d+(\.\d{1,4})?$/;

export function checkRate(rate: string): RuleFormError | null {
  if (rate.trim() === '') return 'rateRequired';
  if (!RATE.test(rate.trim())) return 'rateInvalid';
  return Number(rate) > 100 ? 'rateTooHigh' : null;
}

export function checkRange(from: string, to: string): RuleFormError | null {
  if (from === '') return 'dateRequired';
  return to !== '' && to < from ? 'rangeInvalid' : null;
}

export interface RuleFields {
  authorityCode: string | undefined;
  from: string;
  to: string;
  rate?: string;
  taxCode?: string;
  nature?: string;
  natureRequired?: boolean;
}

/** The first problem with a request form, or null when it can be sent. */
export function firstProblem(fields: RuleFields): RuleFormError | null {
  if (fields.authorityCode === undefined) return 'authorityRequired';
  if (fields.rate !== undefined) {
    const rate = checkRate(fields.rate);
    if (rate !== null) return rate;
  }
  if (fields.taxCode !== undefined && fields.taxCode.trim() === '') return 'taxCodeRequired';
  if (fields.natureRequired === true && (fields.nature ?? '').trim() === '') {
    return 'natureRequired';
  }
  return checkRange(fields.from, fields.to);
}

/** Blank optional text is left out of the request. */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();
