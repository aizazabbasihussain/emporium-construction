const MONEY = /^\d{1,14}(\.\d{1,2})?$/;

/** An amount above zero with at most two decimals. */
export const isPositiveAmount = (value: string): boolean =>
  MONEY.test(value.trim()) && Number(value) > 0;

/** A blank field counts as zero; anything else must be a plain amount. */
export const isAmountOrBlank = (value: string): boolean =>
  value.trim() === '' || MONEY.test(value.trim());

/** `optional('  ')` is undefined so a blank field is left out of the request. */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

const cents = (value: string): number =>
  value.trim() === '' ? 0 : Math.round(Number(value.trim()) * 100);

export interface AllocationRow {
  invoiceId: string;
  amount: string;
  withheld: string;
}

/** Sum of everything the grid allocates, in PKR with two decimals. */
export function allocatedTotal(rows: readonly AllocationRow[]): string {
  const total = rows.reduce((sum, row) => sum + cents(row.amount) + cents(row.withheld), 0);
  return (total / 100).toFixed(2);
}

/** The first missing piece of a receipt form. */
export function receiptProblem(form: {
  partyId: string;
  accountId: string;
  date: string;
  amount: string;
  withheld: string;
  cheque: boolean;
  chequeNumber: string;
  bankName: string;
  chequeDate: string;
  rows: readonly AllocationRow[];
}): 'customer' | 'account' | 'date' | 'amount' | 'cheque' | 'allocation' | null {
  if (form.partyId === '') return 'customer';
  if (!form.cheque && form.accountId === '') return 'account';
  if (form.date === '') return 'date';
  if (!isPositiveAmount(form.amount) || !isAmountOrBlank(form.withheld)) return 'amount';
  if (
    form.cheque &&
    (form.chequeNumber.trim() === '' || form.bankName.trim() === '' || form.chequeDate === '')
  ) {
    return 'cheque';
  }
  const allocated = form.rows.some((row) => cents(row.amount) > 0 || cents(row.withheld) > 0);
  const total = cents(form.amount) + cents(form.withheld);
  // An empty grid leaves the whole receipt as customer credit; a filled one must add up exactly.
  if (allocated && cents(allocatedTotal(form.rows)) !== total) return 'allocation';
  return null;
}
