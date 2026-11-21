const MONEY = /^\d{1,14}(\.\d{1,2})?$/;
const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/;

export const isMoney = (value: string): boolean => MONEY.test(value.trim()) && Number(value) > 0;
export const isQuantity = (value: string): boolean =>
  QUANTITY.test(value.trim()) && Number(value) > 0;

/** `optional('  ')` is undefined so a blank field is left out of the request. */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

/** Quantity times rate in rupees with two decimals, worked in whole units to avoid float drift. */
export function lineAmount(quantity: string, rate: string): string {
  if (!isQuantity(quantity) || !QUANTITY.test(rate.trim())) return '0.00';
  const scaled = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.trim().split('.');
    return BigInt(whole + fraction.padEnd(4, '0'));
  };
  // Both are scaled by 10^4, so the product is scaled by 10^8; one rupee cent is 10^6 of that.
  const cents = (scaled(quantity) * scaled(rate) + 500_000n) / 1_000_000n;
  const text = cents.toString().padStart(3, '0');
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

export interface BillFormLine {
  grnId: string;
  grnLineId: string;
  quantity: string;
  rate: string;
}

/** The first missing piece of a bill form. */
export function billProblem(form: {
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  lines: readonly BillFormLine[];
}): 'vendor' | 'invoiceNo' | 'dates' | 'lines' | 'amounts' | null {
  if (form.vendorPartyId === '') return 'vendor';
  if (form.vendorInvoiceNo.trim() === '') return 'invoiceNo';
  if (form.billDate === '' || form.dueDate === '' || form.dueDate < form.billDate) return 'dates';
  if (form.lines.length === 0) return 'lines';
  if (form.lines.some((line) => !isQuantity(line.quantity) || !QUANTITY.test(line.rate.trim()))) {
    return 'amounts';
  }
  return null;
}

/** Sum of the gross amounts typed into the allocation grid. */
export function allocationTotal(rows: Record<string, string>): string {
  const cents = Object.values(rows).reduce(
    (sum, value) => sum + (value.trim() === '' ? 0 : Math.round(Number(value) * 100)),
    0,
  );
  return (cents / 100).toFixed(2);
}

/** The first missing piece of a payment form. */
export function paymentProblem(form: {
  vendorPartyId: string;
  accountId: string;
  date: string;
  method: string;
  chequeNumber: string;
  chequeDate: string;
  rows: Record<string, string>;
}): 'vendor' | 'account' | 'date' | 'cheque' | 'allocation' | null {
  if (form.vendorPartyId === '') return 'vendor';
  if (form.accountId === '') return 'account';
  if (form.date === '') return 'date';
  if (form.method === 'cheque' && (form.chequeNumber.trim() === '' || form.chequeDate === '')) {
    return 'cheque';
  }
  const filled = Object.values(form.rows).filter((value) => value.trim() !== '');
  if (filled.length === 0 || filled.some((value) => !isMoney(value))) return 'allocation';
  return null;
}
