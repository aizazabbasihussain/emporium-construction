import { describe, expect, it } from 'vitest';
import type { InvoicePrintModel } from '../types.js';
import { invoicePdfLines, renderInvoicePdf } from './pdf.js';

const model: InvoicePrintModel = {
  company: {
    name: 'Synthetic Builders',
    address: 'Office 1 (Main)',
    phone: '051-1',
    email: 'a@example.test',
  },
  registration: { authority: 'FBR', registrationType: 'strn', number: 'TEST-1' },
  client: { name: 'Client', address: 'Road 5', city: 'Lahore', ntn: 'N1', strn: 'S1' },
  invoice: {
    number: 'INV-2026-0001',
    status: 'issued',
    invoiceDate: '2026-11-18',
    dueDate: '2026-12-18',
    projectName: 'Wall',
  },
  lines: [{ description: 'Stage 1', amount: '1000.00' }],
  baseAmount: '1000.00',
  advanceRecovery: '100.00',
  advanceNote: 'Advance recovery is deducted from the total',
  taxableBase: '1000.00',
  taxLines: [{ taxCode: 'ST', ratePercent: '10.0000', base: '1000.00', tax: '100.00' }],
  taxNote: null,
  taxTotal: '100.00',
  grossTotal: '1000.00',
  withholdingNote: 'Tax expected to be withheld by the client: PKR 50.00',
  paymentInstructions: 'Pay to account X',
};

const textOf = (m: InvoicePrintModel) =>
  invoicePdfLines(m)
    .map((l) => l.text)
    .join('\n');

describe('invoice PDF (BR-11)', () => {
  it('prints the company, registration, client, lines, tax, total, withholding and payment note', () => {
    const text = textOf(model);
    for (const part of [
      'Synthetic Builders',
      'FBR STRN: TEST-1',
      'Tax invoice INV-2026-0001',
      'NTN: N1',
      'STRN: S1',
      'Stage 1 - PKR 1,000.00',
      'Advance recovery: PKR 100.00',
      'ST 10.0000% on PKR 1,000.00: PKR 100.00',
      'Total: PKR 1,000.00',
      'withheld by the client',
      'Pay to account X',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('prints a draft without a number, registration, advance, withholding or payment note', () => {
    const text = textOf({
      ...model,
      invoice: { ...model.invoice, number: null },
      registration: null,
      advanceNote: null,
      taxLines: [],
      taxNote: 'No sales tax is charged on this invoice',
      withholdingNote: null,
      paymentInstructions: '  ',
      company: { name: 'X', address: null, phone: null, email: null },
      client: { name: 'C', address: null, city: null, ntn: null, strn: null },
    });
    expect(text).toContain('Tax invoice (draft)');
    expect(text).toContain('No sales tax is charged');
    for (const absent of ['STRN', 'Advance recovery', 'withheld', 'Payment instructions']) {
      expect(text).not.toContain(absent);
    }
  });

  it('renders a valid PDF, escapes brackets, replaces characters outside Latin-1 and paginates', () => {
    const pdf = renderInvoicePdf({
      ...model,
      company: { ...model.company, name: 'Builders (Pvt) \\ Ltd ا' },
      lines: Array.from({ length: 120 }, (_, i) => ({ description: `Line ${i}`, amount: '1.00' })),
    }).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('Builders \\(Pvt\\) \\\\ Ltd ?');
    expect(Number(/\/Count (\d+)/.exec(pdf)?.[1])).toBeGreaterThan(1);
  });

  it('wraps long text at word boundaries and keeps empty paragraphs', () => {
    const lines = invoicePdfLines({
      ...model,
      paymentInstructions: `${'word '.repeat(40)}\n\nlast`,
    }).map((l) => l.text);
    expect(lines.every((l) => l.length <= 88)).toBe(true);
    expect(lines).toContain('last');
    expect(lines).toContain('');
  });
});
