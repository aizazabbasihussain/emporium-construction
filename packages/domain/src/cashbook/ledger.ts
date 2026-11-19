import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

export const directions = ['in', 'out'] as const;
export type Direction = (typeof directions)[number];

export const accountKinds = ['cash', 'bank', 'petty_cash', 'wallet'] as const;
export type AccountKind = (typeof accountKinds)[number];

export const txnTypes = [
  'receipt',
  'payment',
  'transfer_in',
  'transfer_out',
  'bank_charge',
  'advance',
  'other',
] as const;
export type TxnType = (typeof txnTypes)[number];

/** The direction each transaction type implies; `other` takes either (BR-4, BR-6). */
export const typeDirection: Record<TxnType, Direction | null> = {
  receipt: 'in',
  payment: 'out',
  transfer_in: 'in',
  transfer_out: 'out',
  bank_charge: 'out',
  advance: 'out',
  other: null,
};

export interface LedgerEntry {
  direction: Direction;
  amount: string;
  /** Business date, `yyyy-mm-dd`. */
  txnDate: string;
}

/** An amount that adds to the account is positive, one that leaves it negative. */
export function signed(direction: Direction, amount: string): Money {
  const value = Money.of(amount);
  return direction === 'in' ? value : value.negate();
}

export function assertPositiveAmount(amount: string): Money {
  const value = Money.of(amount);
  if (!value.value.gt(0)) {
    throw new ValidationError('amount_invalid', 'The amount must be above zero');
  }
  return value;
}

export function assertDirectionMatchesType(type: TxnType, direction: Direction): void {
  const implied = typeDirection[type];
  if (implied !== null && implied !== direction) {
    throw new ValidationError('direction_mismatch', `A ${type} must be an ${implied} transaction`);
  }
}

/** BR-1: opening balance plus everything in, less everything out, on or before the date. */
export function balanceOn(opening: string, entries: readonly LedgerEntry[], date: string): Money {
  return entries
    .filter((entry) => entry.txnDate <= date)
    .reduce((sum, entry) => sum.add(signed(entry.direction, entry.amount)), Money.of(opening));
}

/** BR-9: what came in and went out on one day. */
export function movementOn(
  entries: readonly LedgerEntry[],
  date: string,
): { in: Money; out: Money } {
  let totalIn = Money.zero();
  let totalOut = Money.zero();
  for (const entry of entries) {
    if (entry.txnDate !== date) continue;
    if (entry.direction === 'in') totalIn = totalIn.add(Money.of(entry.amount));
    else totalOut = totalOut.add(Money.of(entry.amount));
  }
  return { in: totalIn, out: totalOut };
}

/**
 * The lowest end-of-day balance from `from` onward. A backdated payment lowers every later day, so
 * BR-3 is checked against this minimum rather than only the balance on the transaction date.
 */
export function lowestBalanceFrom(
  opening: string,
  entries: readonly LedgerEntry[],
  from: string,
): Money {
  const days = [...new Set([from, ...entries.map((e) => e.txnDate).filter((d) => d >= from)])];
  return days
    .map((day) => balanceOn(opening, entries, day))
    .reduce((lowest, balance) => (balance.compare(lowest) < 0 ? balance : lowest));
}

/**
 * BR-3: cash and petty cash never go below zero; a bank account or wallet may only when the
 * account allows an overdraft. The error carries the shortfall.
 */
export function assertWithinOverdraft(input: {
  kind: AccountKind;
  allowOverdraft: boolean;
  lowestBalance: Money;
}): void {
  const mustStayPositive = input.kind === 'cash' || input.kind === 'petty_cash';
  if ((mustStayPositive || !input.allowOverdraft) && input.lowestBalance.isNegative()) {
    const shortfall = input.lowestBalance.negate().toString();
    throw new RuleViolationError(
      'insufficient_funds',
      `The account would be short by ${shortfall}`,
      { shortfall },
    );
  }
}

/** BR-1: nothing is booked before the opening balance date. */
export function assertAfterOpening(txnDate: string, openingDate: string): void {
  if (txnDate < openingDate) {
    throw new RuleViolationError(
      'before_opening_date',
      `The account opens on ${openingDate}; an earlier date is not allowed`,
    );
  }
}

export interface ReversibleTxn {
  reversesId: string | null;
  reversedById: string | null;
  reconciledIn: string | null;
}

/** BR-2, BR-8: a reversal needs a reason; a reversed, reversing or reconciled entry is not reversed. */
export function assertReversible(txn: ReversibleTxn, reason: string): void {
  if (reason.trim() === '') {
    throw new ValidationError('reason_required', 'A reversal needs a reason');
  }
  if (txn.reversesId !== null) {
    throw new RuleViolationError('is_reversal', 'A reversal cannot be reversed');
  }
  if (txn.reversedById !== null) {
    throw new RuleViolationError('already_reversed', 'The transaction is already reversed');
  }
  if (txn.reconciledIn !== null) {
    throw new RuleViolationError(
      'reconciled',
      'The transaction is reconciled; un-reconcile it before reversing',
    );
  }
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === 'in' ? 'out' : 'in';
}

export interface PositionAccount {
  accountId: string;
  kind: AccountKind;
  balance: string;
  movementIn: string;
  movementOut: string;
}

/**
 * BR-9: cash and petty cash count as cash; bank accounts and wallets as bank (a wallet is held at
 * a provider, not in the safe).
 */
export function summarizePosition(accounts: readonly PositionAccount[]) {
  let cash = Money.zero();
  let bank = Money.zero();
  let movementIn = Money.zero();
  let movementOut = Money.zero();
  for (const account of accounts) {
    const balance = Money.of(account.balance);
    if (account.kind === 'cash' || account.kind === 'petty_cash') cash = cash.add(balance);
    else bank = bank.add(balance);
    movementIn = movementIn.add(Money.of(account.movementIn));
    movementOut = movementOut.add(Money.of(account.movementOut));
  }
  return {
    totalCash: cash.toString(),
    totalBank: bank.toString(),
    total: cash.add(bank).toString(),
    movementIn: movementIn.toString(),
    movementOut: movementOut.toString(),
  };
}
