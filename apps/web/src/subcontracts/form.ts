const MONEY = /^\d{1,14}(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d{1,14}(\.\d{1,2})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

export const isMoney = (value: string): boolean => MONEY.test(value.trim()) && Number(value) > 0;
/** A variation adds (positive) or reduces (negative) the contract, never by zero. */
export const isSignedMoney = (value: string): boolean =>
  SIGNED_MONEY.test(value.trim()) && Number(value) !== 0;
export const isPercent = (value: string): boolean =>
  PERCENT.test(value.trim()) && Number(value) <= 100;

/** `optional('  ')` is undefined so a blank field is left out of the request. */
export const optional = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

/** The first missing piece of a work order form. */
export function orderProblem(form: {
  projectId: string;
  partyId: string;
  title: string;
  contractAmount: string;
  costCodeId: string;
  startDate: string;
  endDate: string;
}): 'project' | 'party' | 'title' | 'amount' | 'costCode' | 'dates' | null {
  if (form.projectId === '') return 'project';
  if (form.partyId === '') return 'party';
  if (form.title.trim() === '') return 'title';
  if (!isMoney(form.contractAmount)) return 'amount';
  if (form.costCodeId === '') return 'costCode';
  if (form.startDate !== '' && form.endDate !== '' && form.endDate < form.startDate) return 'dates';
  return null;
}

/** The first missing piece of a certificate form: its cumulative percent or amount. */
export function certificateProblem(form: {
  date: string;
  basis: 'percent_complete' | 'amount';
  cumulative: string;
}): 'date' | 'percent' | 'amount' | null {
  if (form.date === '') return 'date';
  if (form.basis === 'percent_complete') return isPercent(form.cumulative) ? null : 'percent';
  return isMoney(form.cumulative) ? null : 'amount';
}

/** The first missing piece of a back-charge form. */
export function backChargeProblem(form: {
  description: string;
  amount: string;
  recoversCost: boolean;
  costCodeId: string;
}): 'description' | 'amount' | 'costCode' | null {
  if (form.description.trim() === '') return 'description';
  if (!isMoney(form.amount)) return 'amount';
  if (form.recoversCost && form.costCodeId === '') return 'costCode';
  return null;
}

/** The first missing piece of a variation form. */
export function variationProblem(form: {
  amount: string;
  reason: string;
}): 'amount' | 'reason' | null {
  if (!isSignedMoney(form.amount)) return 'amount';
  if (form.reason.trim() === '') return 'reason';
  return null;
}

/** The first missing piece of the form that turns a certificate into a bill. */
export function billProblem(form: {
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
}): 'invoiceNo' | 'dates' | null {
  if (form.vendorInvoiceNo.trim() === '') return 'invoiceNo';
  if (form.billDate === '' || form.dueDate === '' || form.dueDate < form.billDate) return 'dates';
  return null;
}
