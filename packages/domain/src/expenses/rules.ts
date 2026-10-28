import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';
import type { AdvanceStatus, ClaimStatus } from './status.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** BR-9: lines of one claimant with the same date, amount and category within this many days. */
export const DUPLICATE_WINDOW_DAYS = 7;

export type CostObjectType = 'project' | 'overhead';

export interface ClaimLineInput {
  expenseDate: string;
  category: string;
  description: string;
  costObjectType: CostObjectType;
  costObjectId?: string | null | undefined;
  costCodeId: string;
  amount: string;
  receiptFileId?: string | null | undefined;
}

export interface ClaimLine {
  lineNo: number;
  expenseDate: string;
  category: string;
  description: string;
  costObjectType: CostObjectType;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  receiptFileId: string | null;
}

/** An amount of money: positive, at most two decimals (BR-2). */
export function positiveAmount(text: string, field: string): string {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(text.trim())) {
    throw new ValidationError(
      `${field}_invalid`,
      `${field} must be an amount with at most two decimals`,
    );
  }
  const value = new Dec(text.trim());
  if (!value.greaterThan(0)) {
    throw new ValidationError(`${field}_not_positive`, `${field} must be greater than zero`);
  }
  return value.toFixed(2);
}

/** An amount that may be zero (the threshold of the receipt rule). */
export function nonNegativeAmount(text: string, field: string): string {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(text.trim())) {
    throw new ValidationError(
      `${field}_invalid`,
      `${field} must be an amount with at most two decimals`,
    );
  }
  return new Dec(text.trim()).toFixed(2);
}

/**
 * BR-2: a claim needs at least one line; every line has a date, a category, a description, an amount
 * above zero, a cost object and a cost code. A project line names its project; an overhead line has
 * none.
 */
export function normalizeClaimLines(inputs: readonly ClaimLineInput[]): ClaimLine[] {
  if (inputs.length === 0) {
    throw new ValidationError('lines_required', 'An expense claim needs at least one line');
  }
  return inputs.map((input, index) => {
    const category = input.category.trim();
    if (category === '') {
      throw new ValidationError('category_required', 'Every line needs a category');
    }
    const description = input.description.trim();
    if (description === '') {
      throw new ValidationError('description_required', 'Every line needs a description');
    }
    const costObjectId = input.costObjectId ?? null;
    if (input.costObjectType === 'project' && costObjectId === null) {
      throw new ValidationError('project_required', 'A project line needs a project');
    }
    if (input.costObjectType === 'overhead' && costObjectId !== null) {
      throw new ValidationError('overhead_has_no_project', 'An overhead line has no project');
    }
    return {
      lineNo: index + 1,
      expenseDate: BusinessDate.parse(input.expenseDate).toString(),
      category,
      description,
      costObjectType: input.costObjectType,
      costObjectId,
      costCodeId: input.costCodeId,
      amount: positiveAmount(input.amount, 'amount'),
      receiptFileId: input.receiptFileId ?? null,
    };
  });
}

/** BR-4: the claim total is the sum of the line amounts. */
export function claimTotal(lines: readonly Pick<ClaimLine, 'amount'>[]): string {
  return lines.reduce((sum, line) => sum.plus(line.amount), new Dec(0)).toFixed(2);
}

export interface CategoryRule {
  code: string;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
}

/**
 * BR-3: when the category requires a receipt and the amount is above `max_without_receipt`, the
 * line needs a receipt attachment. An amount equal to the threshold needs none.
 */
export function assertReceipts(
  lines: readonly Pick<ClaimLine, 'lineNo' | 'category' | 'amount' | 'receiptFileId'>[],
  categories: ReadonlyMap<string, CategoryRule>,
): void {
  const missing = lines
    .filter((line) => {
      const rule = categories.get(line.category);
      return (
        rule?.receiptRequired === true &&
        new Dec(line.amount).greaterThan(rule.maxWithoutReceipt) &&
        line.receiptFileId === null
      );
    })
    .map((line) => line.lineNo);
  if (missing.length > 0) {
    throw new RuleViolationError(
      'receipt_required',
      'Attach a receipt to each line that needs one',
      {
        lineNos: missing,
      },
    );
  }
}

export interface PriorLine {
  claimNumber: string;
  lineNo: number;
  expenseDate: string;
  category: string;
  amount: string;
}

export interface Duplicate {
  lineNo: number;
  /** The claim the match is on; null when it is another line of the same claim. */
  matchedClaimNumber: string | null;
  matchedLineNo: number;
}

const sameSpend = (
  a: Pick<ClaimLine, 'expenseDate' | 'category' | 'amount'>,
  b: Pick<ClaimLine, 'expenseDate' | 'category' | 'amount'>,
): boolean =>
  a.category === b.category &&
  new Dec(a.amount).equals(b.amount) &&
  Math.abs(BusinessDate.parse(a.expenseDate).daysSince(BusinessDate.parse(b.expenseDate))) <=
    DUPLICATE_WINDOW_DAYS;

/**
 * BR-9: the lines that look like a repeat of an earlier line of the same claimant, either on the
 * claimant's other claims (`prior`) or earlier in this claim. Each line reports its first match.
 */
export function findDuplicates(
  lines: readonly ClaimLine[],
  prior: readonly PriorLine[],
): Duplicate[] {
  const found: Duplicate[] = [];
  for (const line of lines) {
    const own = lines.find((other) => other.lineNo < line.lineNo && sameSpend(line, other));
    if (own !== undefined) {
      found.push({ lineNo: line.lineNo, matchedClaimNumber: null, matchedLineNo: own.lineNo });
      continue;
    }
    const earlier = prior.find((other) => sameSpend(line, other));
    if (earlier !== undefined) {
      found.push({
        lineNo: line.lineNo,
        matchedClaimNumber: earlier.claimNumber,
        matchedLineNo: earlier.lineNo,
      });
    }
  }
  return found;
}

/** BR-9: the warning must be acknowledged to submit. */
export function assertDuplicatesAcknowledged(
  duplicates: readonly Duplicate[],
  acknowledged: boolean,
): void {
  if (duplicates.length > 0 && !acknowledged) {
    throw new RuleViolationError(
      'duplicate_expense_warning',
      'Some lines look like repeats of earlier claims; acknowledge the warning to submit',
      { duplicates },
    );
  }
}

/** BR-1: only these claim statuses count against a custodian's advances. */
const COUNTED_CLAIMS: readonly ClaimStatus[] = ['approved', 'posted'];

/**
 * BR-1: the custodian balance is the advances issued (settled ones included, cancelled ones not)
 * minus the totals of approved and posted claims. A negative balance means the company owes the
 * claimant.
 */
export function custodianBalance(
  advances: readonly { amount: string; status: AdvanceStatus }[],
  claims: readonly { total: string; status: ClaimStatus }[],
): string {
  const issued = advances
    .filter((advance) => advance.status !== 'cancelled')
    .reduce((sum, advance) => sum.plus(advance.amount), new Dec(0));
  const spent = claims
    .filter((claim) => COUNTED_CLAIMS.includes(claim.status))
    .reduce((sum, claim) => sum.plus(claim.total), new Dec(0));
  return issued.minus(spent).toFixed(2);
}

/** BR-8: the balance has returned to zero. */
export const isBalanceZero = (balance: string): boolean => new Dec(balance).isZero();

/** BR-8: the accountant may settle by hand; unless the balance is zero a note says why. */
export function settlementNote(balance: string, note: string | null | undefined): string | null {
  const text = note?.trim() ?? '';
  if (text === '' && !isBalanceZero(balance)) {
    throw new ValidationError('note_required', 'Add a note to settle an advance by hand');
  }
  return text === '' ? null : text;
}

/** The lines of a claim as cost entries: one per line, keyed `exp:<line id>` (BR-5). */
export const costKey = (lineId: string): string => `exp:${lineId}`;
