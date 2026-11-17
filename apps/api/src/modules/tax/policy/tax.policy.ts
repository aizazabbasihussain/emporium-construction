import { Percent } from '@emporium/domain/kernel';
import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';

/** A missing record is reported as not found, whoever asks. */
export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** A rule can only name an authority the module knows. */
export function assertAuthorityKnown(known: readonly string[], code: string): void {
  if (!known.includes(code)) {
    throw new ValidationError('tax_authority_unknown', `Unknown tax authority ${code}`);
  }
}

/** The rate is a percentage from 0 to 100 (BR-3); a rate of 0 is allowed. */
export function assertRateInRange(rate: Percent): void {
  if (rate.isNegative() || rate.compare(Percent.of('100')) > 0) {
    throw new ValidationError('tax_rate_out_of_range', 'A rate must be between 0 and 100 percent');
  }
}

/** BR-9: the company must be registered with the authority on the document date. */
export function assertRegistered<T>(
  registration: T | null,
  authorityCode: string,
  date: string,
): T {
  if (registration === null) {
    throw new RuleViolationError(
      'tax_registration_missing',
      `The company has no ${authorityCode} registration on ${date}`,
    );
  }
  return registration;
}

/** A calendar month `yyyy-mm`. */
export function assertMonth(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new ValidationError('invalid_month', 'The month must look like 2026-10');
  }
}

/** The person who decided an approval: the last one to act, if anyone did. */
export function deciderOf(state: {
  status: string;
  actions?: readonly { actorId: string }[];
}): string | null {
  return state.actions?.at(-1)?.actorId ?? null;
}
