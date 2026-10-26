import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface LineInput {
  description: string;
  costCodeId: string;
  costAmount: string;
  priceAmount: string;
}

export interface Line extends LineInput {
  lineNo: number;
}

const money = (text: string, field: string): Decimal => {
  if (!/^-?\d{1,16}(\.\d{1,2})?$/.test(text.trim())) {
    throw new ValidationError(
      `${field}_invalid`,
      `${field} must be an amount with at most two decimals`,
    );
  }
  return new Dec(text.trim());
};

/**
 * BR-2: a variation needs at least one line. The price of a line may be negative (a deductive
 * variation); its cost may not, because the budget only grows through `addBudgetLine`.
 */
export function normalizeLines(inputs: readonly LineInput[]): Line[] {
  if (inputs.length === 0) {
    throw new ValidationError('lines_required', 'A variation needs at least one line');
  }
  return inputs.map((input, index) => {
    const description = input.description.trim();
    if (description === '') {
      throw new ValidationError('description_required', 'Every line needs a description');
    }
    const cost = money(input.costAmount, 'cost_amount');
    if (cost.isNegative()) {
      throw new ValidationError('cost_amount_negative', 'The cost of a line cannot be negative');
    }
    return {
      lineNo: index + 1,
      description,
      costCodeId: input.costCodeId,
      costAmount: cost.toFixed(2),
      priceAmount: money(input.priceAmount, 'price_amount').toFixed(2),
    };
  });
}

/** BR-2: the impacts equal the sums of the line amounts. */
export function impactTotals(lines: readonly Pick<Line, 'costAmount' | 'priceAmount'>[]): {
  priceImpact: string;
  costImpact: string;
} {
  let price = new Dec(0);
  let cost = new Dec(0);
  for (const line of lines) {
    price = price.plus(line.priceAmount);
    cost = cost.plus(line.costAmount);
  }
  return { priceImpact: price.toFixed(2), costImpact: cost.toFixed(2) };
}

/** BR-5: the current contract value is the original plus the approved price impacts. */
export function currentContractValue(
  original: string,
  approvedPriceImpacts: readonly string[],
): string {
  let value = new Dec(original);
  for (const impact of approvedPriceImpacts) value = value.plus(impact);
  return value.toFixed(2);
}

/** BR-3: the client sees a variation only after the internal approval was granted. */
export function assertInternallyApproved(approvalStatus: string): void {
  if (approvalStatus !== 'approved') {
    throw new RuleViolationError(
      'internal_approval_required',
      'The variation needs internal approval before it is sent to the client',
    );
  }
}

export interface ClientApprovalInput {
  reference: string | null | undefined;
  approvedOn: string | null | undefined;
  hasDocument: boolean;
}

/** BR-4: the client's reference, a date that is not in the future, and the attached document. */
export function checkClientApproval(
  input: ClientApprovalInput,
  today: BusinessDate,
): { reference: string; approvedOn: string } {
  const reference = input.reference?.trim() ?? '';
  if (reference === '') {
    throw new ValidationError('client_reference_required', 'Enter the client approval reference');
  }
  if (input.approvedOn === null || input.approvedOn === undefined) {
    throw new ValidationError('client_date_required', 'Enter the date the client approved');
  }
  const approvedOn = BusinessDate.parse(input.approvedOn);
  if (approvedOn.toString() > today.toString()) {
    throw new ValidationError('client_date_future', 'The approval date cannot be in the future');
  }
  if (!input.hasDocument) {
    throw new RuleViolationError(
      'client_document_required',
      'Attach the client letter or signed form',
    );
  }
  return { reference, approvedOn: approvedOn.toString() };
}

/** BR-1: `<project code>-V<n>`. */
export const variationNumber = (projectCode: string, seq: number): string =>
  `${projectCode}-V${seq}`;

/**
 * The approval rules band on an amount that cannot be negative, so a deductive variation is
 * submitted for approval at the size of its price impact.
 */
export const approvalAmount = (priceImpact: string): string =>
  new Dec(priceImpact).abs().toFixed(2);

/**
 * BR-5: the budget lines a client-approved variation adds, one per line that costs something. The
 * description carries the variation number and line number so no two lines clash in the budget.
 */
export function budgetLines(
  number: string,
  lines: readonly Pick<Line, 'lineNo' | 'description' | 'costCodeId' | 'costAmount'>[],
): { costCodeId: string; description: string; budgetAmount: string }[] {
  return lines
    .filter((line) => new Dec(line.costAmount).greaterThan(0))
    .map((line) => ({
      costCodeId: line.costCodeId,
      description: `${number} L${line.lineNo}: ${line.description}`,
      budgetAmount: line.costAmount,
    }));
}
