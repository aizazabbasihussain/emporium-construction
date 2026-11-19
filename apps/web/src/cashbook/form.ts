const MONEY = /^\d{1,14}(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d{1,14}(\.\d{1,2})?$/;

/** An amount above zero with at most two decimals. */
export const isPositiveAmount = (value: string): boolean =>
  MONEY.test(value.trim()) && Number(value) > 0;

/** An amount that may be zero or negative (an opening balance, a statement closing balance). */
export const isSignedAmount = (value: string): boolean => SIGNED_MONEY.test(value.trim());

/** `optional('  ')` is undefined so a blank field is left out of the request. */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

/** The first missing piece of a receipt or payment form. */
export function entryProblem(form: {
  accountId: string;
  txnDate: string;
  amount: string;
}): 'account' | 'date' | 'amount' | null {
  if (form.accountId === '') return 'account';
  if (form.txnDate === '') return 'date';
  if (!isPositiveAmount(form.amount)) return 'amount';
  return null;
}

/** The first problem of a transfer form. */
export function transferProblem(form: {
  fromAccountId: string;
  toAccountId: string;
  txnDate: string;
  amount: string;
}): 'account' | 'same' | 'date' | 'amount' | null {
  if (form.fromAccountId === '' || form.toAccountId === '') return 'account';
  if (form.fromAccountId === form.toAccountId) return 'same';
  if (form.txnDate === '') return 'date';
  if (!isPositiveAmount(form.amount)) return 'amount';
  return null;
}
