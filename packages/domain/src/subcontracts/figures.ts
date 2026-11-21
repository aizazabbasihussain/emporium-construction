import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const sumOf = (values: readonly string[]): Money =>
  values.reduce((acc, value) => acc.add(Money.of(value)), Money.zero());

/** BR-8: retention is out of scope in this version; any other value is refused. */
export function assertNoRetention(percent: string | undefined): void {
  if (percent !== undefined && !new Dec(percent).isZero()) {
    throw new RuleViolationError(
      'retention_not_supported',
      'Retention is not supported yet (see BACKLOG)',
    );
  }
}

/** BR-1: the contract amount is positive money. */
export function normalizeContractAmount(text: string): string {
  const amount = Money.of(text);
  if (amount.isNegative() || amount.isZero()) {
    throw new ValidationError('contract_amount_invalid', 'The contract amount must be above zero');
  }
  return amount.toString();
}

/** A variation adds to the contract (positive) or reduces it (negative), never by zero. */
export function normalizeVariationAmount(text: string): string {
  const amount = Money.of(text);
  if (amount.isZero()) {
    throw new ValidationError('variation_amount_invalid', 'The variation amount cannot be zero');
  }
  return amount.toString();
}

/** A back-charge is a positive amount held back from the subcontractor. */
export function normalizeBackChargeAmount(text: string): string {
  const amount = Money.of(text);
  if (amount.isNegative() || amount.isZero()) {
    throw new ValidationError('back_charge_invalid', 'The back-charge must be above zero');
  }
  return amount.toString();
}

/** BR-1 and BR-2: the contract amount including the approved variations. */
export function currentContractAmount(
  contract: string,
  approvedVariations: readonly string[],
): string {
  return Money.of(contract).add(sumOf(approvedVariations)).toString();
}

/**
 * BR-1: an approved variation changes the contract; the result must stay above zero and cannot fall
 * below what has already been certified.
 */
export function assertVariationFits(input: {
  currentContract: string;
  variation: string;
  certified: string;
}): string {
  const next = Money.of(input.currentContract).add(Money.of(input.variation));
  if (next.isNegative() || next.isZero() || next.compare(Money.of(input.certified)) < 0) {
    throw new RuleViolationError(
      'variation_below_certified',
      'The contract cannot fall below the amount already certified',
    );
  }
  return next.toString();
}

export interface CertificateInput {
  basis: 'percent_complete' | 'amount';
  /** The current contract amount including approved variations. */
  contractAmount: string;
  /** The cumulative gross of the latest certified certificate (zero for the first). */
  previousCumulative: string;
  cumulativePercent?: string | undefined;
  cumulativeAmount?: string | undefined;
  /** The sum of the back-charges linked to the certificate (BR-3). */
  deductions: string;
}

export interface CertificateFigures {
  cumulativePercent: string;
  cumulativeAmount: string;
  thisCertificateAmount: string;
  deductions: string;
  netCertified: string;
}

function percentOf(amount: Money, contract: Money): string {
  return new Dec(amount.toString()).div(contract.toString()).times(100).toFixed(4);
}

/**
 * BR-2 and BR-3: the cumulative figures of a certificate. The cumulative amount (or percent of the
 * current contract) may not pass the contract, this certificate is the step up from the previous
 * cumulative and is positive (or zero only when deductions alone are certified), and the net after
 * deductions cannot be negative.
 */
export function certificateFigures(input: CertificateInput): CertificateFigures {
  const contract = Money.of(input.contractAmount);
  let cumulative: Money;
  let cumulativePercent: string;
  if (input.basis === 'percent_complete') {
    if (input.cumulativePercent === undefined) {
      throw new ValidationError('percent_required', 'Enter the cumulative percent complete');
    }
    const percent = new Dec(input.cumulativePercent);
    if (percent.isNegative() || percent.decimalPlaces() > 4) {
      throw new ValidationError(
        'percent_invalid',
        'The percent must be zero or more, to 4 decimals',
      );
    }
    if (percent.greaterThan(100)) {
      throw new RuleViolationError(
        'over_certified',
        'Certification cannot pass the contract amount',
      );
    }
    cumulative = Money.of(new Dec(contract.toString()).times(percent).div(100));
    cumulativePercent = percent.toFixed(4);
  } else {
    if (input.cumulativeAmount === undefined) {
      throw new ValidationError('amount_required', 'Enter the cumulative certified amount');
    }
    cumulative = Money.of(input.cumulativeAmount);
    if (cumulative.isNegative()) {
      throw new ValidationError('amount_invalid', 'The cumulative amount cannot be negative');
    }
    if (cumulative.compare(contract) > 0) {
      throw new RuleViolationError(
        'over_certified',
        'Certification cannot pass the contract amount',
      );
    }
    cumulativePercent = percentOf(cumulative, contract);
  }
  const step = cumulative.sub(Money.of(input.previousCumulative));
  const deductions = Money.of(input.deductions);
  if (step.isNegative()) {
    throw new RuleViolationError(
      'certificate_not_cumulative',
      'The cumulative amount cannot be below the previous certificate',
    );
  }
  if (step.isZero() && deductions.isZero()) {
    throw new RuleViolationError(
      'certificate_empty',
      'A certificate needs new work or at least one deduction',
    );
  }
  const net = step.sub(deductions);
  if (net.isNegative()) {
    throw new RuleViolationError(
      'negative_net',
      'The deductions are more than the amount certified',
    );
  }
  return {
    cumulativePercent,
    cumulativeAmount: cumulative.toString(),
    thisCertificateAmount: step.toString(),
    deductions: deductions.toString(),
    netCertified: net.toString(),
  };
}

/** BR-3: the deductions of a certificate are the sum of its back-charges. */
export function deductionsOf(amounts: readonly string[]): string {
  return sumOf(amounts).toString();
}

/** BR-1 and BR-4: what is still committed once `certified` of the contract is certified. */
export function remainingCommitment(contractAmount: string, certified: string): string {
  const remaining = Money.of(contractAmount).sub(Money.of(certified));
  return remaining.isNegative() ? Money.zero().toString() : remaining.toString();
}

/** BR-6: an order is complete when the whole current contract is certified. */
export const isFullyCertified = (contractAmount: string, certified: string): boolean =>
  Money.of(certified).compare(Money.of(contractAmount)) >= 0;

/**
 * BR-4: the cost entries a certification posts. The gross amount is `approved` cost; a back-charge
 * that recovers a company cost is a negative `approved` entry on its own cost code. Other
 * back-charges only reduce the payable.
 */
export function certificationEntries(input: {
  grossAmount: string;
  costCodeId: string;
  backCharges: readonly {
    id: string;
    amount: string;
    recoversCost: boolean;
    costCodeId: string | null;
  }[];
}): {
  gross: { amount: string; costCodeId: string };
  recoveries: { backChargeId: string; amount: string; costCodeId: string }[];
} {
  const gross = Money.of(input.grossAmount);
  if (gross.isNegative() || gross.isZero()) {
    throw new RuleViolationError(
      'certificate_empty',
      'A certificate needs new work to be certified',
    );
  }
  return {
    gross: { amount: gross.toString(), costCodeId: input.costCodeId },
    recoveries: input.backCharges
      .filter((charge) => charge.recoversCost)
      .map((charge) => ({
        backChargeId: charge.id,
        amount: Money.of(charge.amount).negate().toString(),
        costCodeId: charge.costCodeId as string,
      })),
  };
}

/** BR-5: what the bill built from a certificate carries as its base. */
export function billBase(netCertified: string): string {
  const net = Money.of(netCertified);
  if (net.isNegative() || net.isZero()) {
    throw new RuleViolationError(
      'net_not_billable',
      'There is nothing to bill: the net certified is zero',
    );
  }
  return net.toString();
}
