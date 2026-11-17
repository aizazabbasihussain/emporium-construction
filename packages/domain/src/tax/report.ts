import { Money } from '../kernel/money.js';

/** One stored tax snapshot line handed over by an owning module's view (BR-8). */
export type TaxReportKind =
  'invoice' | 'credit_note' | 'vendor_bill' | 'withholding_deducted' | 'withholding_suffered';

export interface TaxReportRow {
  documentId: string;
  kind: TaxReportKind;
  /** yyyy-mm-dd */
  date: string;
  base: string;
  /** The tax, or the withheld amount for the two withholding kinds. */
  tax: string;
}

export interface TaxReportTotals {
  base: string;
  tax: string;
  documents: number;
}

export interface TaxReport {
  outputTax: TaxReportTotals;
  inputTax: TaxReportTotals;
  withholdingDeducted: TaxReportTotals;
  withholdingSuffered: TaxReportTotals;
}

interface Accumulator {
  base: Money;
  tax: Money;
  documents: number;
}

const empty = (): Accumulator => ({ base: Money.zero(), tax: Money.zero(), documents: 0 });

const finish = (acc: Accumulator): TaxReportTotals => ({
  base: acc.base.toString(),
  tax: acc.tax.toString(),
  documents: acc.documents,
});

/**
 * BR-8: output tax is invoices less credit notes, input tax is vendor bills, and the two
 * withholding figures are summed as they stand. A document counts once.
 */
export function aggregateTaxReport(rows: readonly TaxReportRow[]): TaxReport {
  const output = empty();
  const input = empty();
  const deducted = empty();
  const suffered = empty();
  for (const row of rows) {
    const target = {
      invoice: output,
      credit_note: output,
      vendor_bill: input,
      withholding_deducted: deducted,
      withholding_suffered: suffered,
    }[row.kind];
    const sign = row.kind === 'credit_note';
    const base = sign ? Money.of(row.base).negate() : Money.of(row.base);
    const tax = sign ? Money.of(row.tax).negate() : Money.of(row.tax);
    target.base = target.base.add(base);
    target.tax = target.tax.add(tax);
    target.documents += 1;
  }
  return {
    outputTax: finish(output),
    inputTax: finish(input),
    withholdingDeducted: finish(deducted),
    withholdingSuffered: finish(suffered),
  };
}
