import Decimal from 'decimal.js';
import { Money } from '../kernel/index.js';

/** BR-7: a percent rounded half-up to 2 decimals; null when the base is zero. */
export function percentOf(part: string, whole: string): string | null {
  const base = new Decimal(Money.of(whole).toString());
  if (base.isZero()) return null;
  return new Decimal(Money.of(part).toString())
    .div(base)
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

const sum = (values: readonly string[]): Money =>
  values.reduce((total, value) => total.add(Money.of(value)), Money.zero());

export interface FinancialsInput {
  /** Original plus approved variations. */
  contractValue: string;
  /** Issued invoices net of credit notes, before advance recovery. */
  billed: { base: string; tax: string; gross: string };
  /** Receipts allocated to the project's invoices; gross includes the withheld tax certified. */
  collected: { gross: string; withheld: string; base: string };
  /** The cost ledger by status; `budget` is the total of the budget lines. */
  cost: { committed: string; approved: string; posted: string; budget: string };
  /** What went out for the project. */
  paidOut: { vendors: string; wages: string; expenses: string };
  /** The latest manual cost-to-complete forecast, when one was set. */
  forecast: string | null;
}

export interface Financials {
  contractValue: string;
  billedBase: string;
  billedTax: string;
  billedGross: string;
  billedPercent: string | null;
  collectedGross: string;
  collectedBase: string;
  withheldTax: string;
  collectedPercent: string | null;
  outstandingReceivable: string;
  committed: string;
  approved: string;
  posted: string;
  /** Committed plus approved plus posted. */
  costToDate: string;
  budget: string;
  costPercentOfBudget: string | null;
  costToComplete: string;
  costToCompleteSource: 'forecast' | 'budget';
  expectedMargin: string;
  expectedMarginPercent: string | null;
  currentMargin: string;
  currentMarginPercent: string | null;
  paidOutVendors: string;
  paidOutWages: string;
  paidOutExpenses: string;
  paidOut: string;
  cashPosition: string;
}

/**
 * BR-2: cost to complete is the manual forecast when one is set, else the budget not yet used,
 * never below zero.
 */
export function costToComplete(
  forecast: string | null,
  budget: string,
  costToDate: string,
): { amount: string; source: 'forecast' | 'budget' } {
  if (forecast !== null) return { amount: Money.of(forecast).toString(), source: 'forecast' };
  const left = Money.of(budget).sub(Money.of(costToDate));
  return { amount: (left.isNegative() ? Money.zero() : left).toString(), source: 'budget' };
}

/** BR-1 to BR-3 and BR-7 for one project on one date. */
export function computeFinancials(input: FinancialsInput): Financials {
  const { cost, billed, collected, paidOut } = input;
  const costToDate = sum([cost.committed, cost.approved, cost.posted]).toString();
  const toComplete = costToComplete(input.forecast, cost.budget, costToDate);
  const expectedMargin = Money.of(input.contractValue)
    .sub(Money.of(costToDate))
    .sub(Money.of(toComplete.amount))
    .toString();
  // Current margin counts only what is billed against posted and approved cost: committed is a promise.
  const currentMargin = Money.of(billed.base)
    .sub(Money.of(cost.posted))
    .sub(Money.of(cost.approved))
    .toString();
  const paidOutTotal = sum([paidOut.vendors, paidOut.wages, paidOut.expenses]).toString();
  return {
    contractValue: Money.of(input.contractValue).toString(),
    billedBase: Money.of(billed.base).toString(),
    billedTax: Money.of(billed.tax).toString(),
    billedGross: Money.of(billed.gross).toString(),
    billedPercent: percentOf(billed.base, input.contractValue),
    collectedGross: Money.of(collected.gross).toString(),
    collectedBase: Money.of(collected.base).toString(),
    withheldTax: Money.of(collected.withheld).toString(),
    collectedPercent: percentOf(collected.base, input.contractValue),
    outstandingReceivable: Money.of(billed.gross).sub(Money.of(collected.gross)).toString(),
    committed: Money.of(cost.committed).toString(),
    approved: Money.of(cost.approved).toString(),
    posted: Money.of(cost.posted).toString(),
    costToDate,
    budget: Money.of(cost.budget).toString(),
    costPercentOfBudget: percentOf(costToDate, cost.budget),
    costToComplete: toComplete.amount,
    costToCompleteSource: toComplete.source,
    expectedMargin,
    expectedMarginPercent: percentOf(expectedMargin, input.contractValue),
    currentMargin,
    currentMarginPercent: percentOf(currentMargin, billed.base),
    paidOutVendors: Money.of(paidOut.vendors).toString(),
    paidOutWages: Money.of(paidOut.wages).toString(),
    paidOutExpenses: Money.of(paidOut.expenses).toString(),
    paidOut: paidOutTotal,
    cashPosition: Money.of(collected.gross).sub(Money.of(paidOutTotal)).toString(),
  };
}
