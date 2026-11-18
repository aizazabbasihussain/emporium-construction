import { Money } from '../kernel/money.js';

export interface InvoicePrintSource {
  company: { name: string; address: string | null; phone: string | null; email: string | null };
  /** The registration for the invoice's authority (BR-11). */
  registration: { authority: string; registrationType: string; number: string } | null;
  client: {
    name: string;
    address: string | null;
    city: string | null;
    ntn: string | null;
    strn: string | null;
  };
  invoice: {
    number: string | null;
    status: string;
    invoiceDate: string;
    dueDate: string;
    projectName: string;
  };
  lines: { description: string; amount: string }[];
  baseAmount: string;
  advanceRecovery: string;
  taxOnAdvanceAtReceipt: boolean;
  taxableBase: string;
  taxGroups: { taxCode: string; ratePercent: string; base: string; tax: string }[];
  taxTotal: string;
  grossTotal: string;
  withholdingExpected: string;
  paymentInstructions: string;
}

export interface InvoicePrintModel {
  company: InvoicePrintSource['company'];
  registration: InvoicePrintSource['registration'];
  client: InvoicePrintSource['client'];
  invoice: InvoicePrintSource['invoice'];
  lines: InvoicePrintSource['lines'];
  baseAmount: string;
  advanceRecovery: string;
  advanceNote: string | null;
  taxableBase: string;
  taxLines: InvoicePrintSource['taxGroups'];
  taxNote: string | null;
  taxTotal: string;
  grossTotal: string;
  withholdingNote: string | null;
  paymentInstructions: string;
}

/**
 * BR-11: the print model lists exactly these fields. The notes, the approval trail, the tax rule
 * ids and every other internal field are never copied in, so no print output can show them.
 */
export function buildInvoicePrintModel(source: InvoicePrintSource): InvoicePrintModel {
  const recovery = Money.of(source.advanceRecovery);
  return {
    company: { ...source.company },
    registration: source.registration === null ? null : { ...source.registration },
    client: { ...source.client },
    invoice: { ...source.invoice },
    lines: source.lines.map((line) => ({ description: line.description, amount: line.amount })),
    baseAmount: source.baseAmount,
    advanceRecovery: source.advanceRecovery,
    advanceNote: recovery.isZero()
      ? null
      : source.taxOnAdvanceAtReceipt
        ? 'Advance recovery is deducted from the total; tax on the advance was charged when it was invoiced'
        : 'Advance recovery reduces the taxable base of this invoice',
    taxableBase: source.taxableBase,
    taxLines: source.taxGroups.map((group) => ({ ...group })),
    taxNote: source.taxGroups.length === 0 ? 'No sales tax is charged on this invoice' : null,
    taxTotal: source.taxTotal,
    grossTotal: source.grossTotal,
    withholdingNote: Money.of(source.withholdingExpected).isZero()
      ? null
      : `Tax expected to be withheld by the client: PKR ${source.withholdingExpected}`,
    paymentInstructions: source.paymentInstructions,
  };
}
