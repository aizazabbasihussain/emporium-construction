import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money.js';
import { calculateSalesTax } from '../tax/calculate.js';
import {
  advanceRecovery,
  applyScheduleEdit,
  assertCancellableDirectly,
  assertEditable,
  assertRecoveryMethod,
  assertScheduleMatchesContract,
  assertTransition,
  assertWithinContract,
  buildInvoicePrintModel,
  computeCredit,
  dueDateOf,
  grossTotal,
  invoiceSeriesFor,
  invoiceStatuses,
  invoiceTransitions,
  nextStageNo,
  scheduleFromQuotation,
  scheduleTotal,
  spreadReduction,
  taxableBase,
  variationStage,
  type CreditedInvoice,
  type InvoicePrintSource,
  type InvoiceStatus,
  type PlannedStage,
} from './index.js';

const RULE = { id: 'r1', authorityCode: 'FBR', taxCode: 'TEST-ST', ratePercent: '10' };
const taxOf = (taxable: string) =>
  calculateSalesTax([{ id: 'l', amount: taxable, rule: RULE }], {
    roundingMode: 'per_document',
    pricesIncludeTax: false,
  });

describe('worked invoice examples (T-2): stage 30% of 5,000,000, synthetic 10% tax', () => {
  const stage = { invoiceBase: '1500000.00', remainingUnbilled: '5000000.00' };

  it('without an advance: base 1,500,000, tax 150,000, gross 1,650,000', () => {
    const recovery = advanceRecovery({
      method: 'proportional',
      unapplied: '0',
      ...stage,
      fixedPercent: '0',
    });
    expect(recovery).toBe('0.00');
    const taxable = taxableBase(stage.invoiceBase, recovery, true);
    const tax = taxOf(taxable).taxTotal;
    expect(taxable).toBe('1500000.00');
    expect(tax).toBe('150000.00');
    expect(grossTotal(taxable, tax, recovery, true)).toBe('1650000.00');
  });

  it('proportional recovery of a 500,000 advance is 150,000, tax charged at receipt', () => {
    const recovery = advanceRecovery({
      method: 'proportional',
      unapplied: '500000.00',
      ...stage,
      fixedPercent: '0',
    });
    expect(recovery).toBe('150000.00');
    const taxable = taxableBase(stage.invoiceBase, recovery, true);
    const tax = taxOf(taxable).taxTotal;
    expect([taxable, tax]).toEqual(['1500000.00', '150000.00']);
    // The recovery is a deduction line: 1,500,000 + 150,000 - 150,000.
    expect(grossTotal(taxable, tax, recovery, true)).toBe('1500000.00');
  });

  it('proportional recovery, tax not charged at receipt: recovery reduces the taxable base', () => {
    const recovery = advanceRecovery({
      method: 'proportional',
      unapplied: '500000.00',
      ...stage,
      fixedPercent: '0',
    });
    const taxable = taxableBase(stage.invoiceBase, recovery, false);
    const tax = taxOf(taxable).taxTotal;
    expect([taxable, tax]).toEqual(['1350000.00', '135000.00']);
    expect(grossTotal(taxable, tax, recovery, false)).toBe('1485000.00');
  });

  it('fixed percent recovers a share of every invoice base (8% of 1,500,000)', () => {
    const recovery = advanceRecovery({
      method: 'fixed_percent',
      unapplied: '500000.00',
      ...stage,
      fixedPercent: '8',
    });
    expect(recovery).toBe('120000.00');
    const taxable = taxableBase(stage.invoiceBase, recovery, false);
    expect(taxable).toBe('1380000.00');
    expect(grossTotal(taxable, taxOf(taxable).taxTotal, recovery, false)).toBe('1518000.00');
  });
});

describe('advance recovery limits (BR-3)', () => {
  const base = { method: 'proportional' as const, fixedPercent: '0' };

  it('rounds half-up to the paisa', () => {
    // 100.00 x 1 / 3 = 33.333... and 200.00 x 1.00 / 3 = 66.666...
    expect(
      advanceRecovery({
        ...base,
        unapplied: '100.00',
        invoiceBase: '50.00',
        remainingUnbilled: '150.00',
      }),
    ).toBe('33.33');
    expect(
      advanceRecovery({
        ...base,
        unapplied: '200.00',
        invoiceBase: '100.00',
        remainingUnbilled: '300.00',
      }),
    ).toBe('66.67');
  });

  it('never exceeds the unapplied advance', () => {
    expect(
      advanceRecovery({
        ...base,
        unapplied: '10.00',
        invoiceBase: '500.00',
        remainingUnbilled: '500.00',
      }),
    ).toBe('10.00');
  });

  it('never exceeds the invoice base', () => {
    expect(
      advanceRecovery({
        method: 'fixed_percent',
        unapplied: '900.00',
        invoiceBase: '100.00',
        remainingUnbilled: '1000.00',
        fixedPercent: '100',
      }),
    ).toBe('100.00');
    expect(
      advanceRecovery({
        ...base,
        unapplied: '900.00',
        invoiceBase: '100.00',
        remainingUnbilled: '50.00',
      }),
    ).toBe('100.00');
  });

  it('takes the whole advance back when nothing is left unbilled', () => {
    expect(
      advanceRecovery({
        ...base,
        unapplied: '40.00',
        invoiceBase: '100.00',
        remainingUnbilled: '0',
      }),
    ).toBe('40.00');
  });

  it('recovers nothing without an advance or without a base', () => {
    expect(
      advanceRecovery({
        ...base,
        unapplied: '0',
        invoiceBase: '100.00',
        remainingUnbilled: '100.00',
      }),
    ).toBe('0.00');
    expect(
      advanceRecovery({
        ...base,
        unapplied: '50.00',
        invoiceBase: '0',
        remainingUnbilled: '100.00',
      }),
    ).toBe('0.00');
  });

  it('refuses a fixed percent outside 0 to 100', () => {
    for (const fixedPercent of ['-1', '100.01']) {
      expect(() =>
        advanceRecovery({
          method: 'fixed_percent',
          unapplied: '50.00',
          invoiceBase: '100.00',
          remainingUnbilled: '100.00',
          fixedPercent,
        }),
      ).toThrow('0 to 100');
    }
  });

  it('accepts only the two methods', () => {
    expect(assertRecoveryMethod('proportional')).toBe('proportional');
    expect(assertRecoveryMethod('fixed_percent')).toBe('fixed_percent');
    expect(() => assertRecoveryMethod('half')).toThrow('proportional or fixed_percent');
  });
});

describe('spreading a reduction over lines (BR-3)', () => {
  it('takes it from the lines in proportion and the last line absorbs rounding', () => {
    expect(spreadReduction(['600.00', '400.00'], '100.00')).toEqual(['540.00', '360.00']);
    const parts = spreadReduction(['100.00', '100.00', '100.00'], '100.00');
    expect(parts).toEqual(['66.67', '66.67', '66.66']);
    expect(parts.reduce((s, p) => s.add(Money.of(p)), Money.zero()).toString()).toBe('200.00');
  });

  it('puts it all on the first line when every line is zero, and on the only line', () => {
    expect(spreadReduction(['0', '0'], '5')).toEqual(['-5.00', '0.00']);
    expect(spreadReduction(['50.00'], '20')).toEqual(['30.00']);
  });
});

describe('contract limit, due date and series', () => {
  it('allows billing up to the contract value and refuses above it (BR-7)', () => {
    const contractValue = '1000.00';
    expect(() =>
      assertWithinContract({ contractValue, netBilled: '600.00', adding: '400.00' }),
    ).not.toThrow();
    expect(() =>
      assertWithinContract({ contractValue, netBilled: '600.00', adding: '400.01' }),
    ).toThrow('exceed the contract value 1000.00');
  });

  it('adds the payment days to the invoice date (BR-10)', () => {
    expect(dueDateOf('2026-11-18', 30)).toBe('2026-12-18');
    expect(dueDateOf('2026-12-20', 15)).toBe('2027-01-04');
    expect(dueDateOf('2026-11-18', 0)).toBe('2026-11-18');
  });

  it('uses the series of the authority when one exists, else the shared one (BR-5)', () => {
    expect(invoiceSeriesFor('PRA', ['invoice', 'invoice_pra'], 'invoice')).toBe('invoice_pra');
    expect(invoiceSeriesFor('FBR', ['invoice', 'invoice_pra'], 'invoice')).toBe('invoice');
  });
});

describe('invoice state machine (T-5)', () => {
  it('allows exactly the listed transitions and refuses all others', () => {
    for (const from of invoiceStatuses) {
      for (const to of invoiceStatuses) {
        const allowed = invoiceTransitions[from].includes(to);
        if (allowed) expect(() => assertTransition(from, to), `${from} -> ${to}`).not.toThrow();
        else expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow('cannot go from');
      }
    }
  });

  it('locks every status but draft against edits, with a message for an issued invoice', () => {
    expect(() => assertEditable('draft')).not.toThrow();
    expect(() => assertEditable('issued')).toThrow('correct it with a credit note');
    for (const status of ['pending_approval', 'approved', 'cancelled'] as InvoiceStatus[]) {
      expect(() => assertEditable(status)).toThrow('Only a draft');
    }
  });

  it('never cancels an issued invoice directly (BR-5)', () => {
    expect(() => assertCancellableDirectly('issued')).toThrow('only by a credit note');
    for (const status of [
      'draft',
      'pending_approval',
      'approved',
      'cancelled',
    ] as InvoiceStatus[]) {
      expect(() => assertCancellableDirectly(status)).not.toThrow();
    }
  });
});

describe('billing schedule (T-1)', () => {
  const quotationStages = [
    { stageNo: 1, name: 'Mobilization', basis: 'percent' as const, percent: '30', amount: '0' },
    { stageNo: 2, name: 'Structure', basis: 'percent' as const, percent: '40', amount: '0' },
    { stageNo: 3, name: 'Handover', basis: 'percent' as const, percent: '30', amount: '0' },
  ];

  it('builds the stages as percents of the original contract value and sums to it', () => {
    const stages = scheduleFromQuotation('5000000', quotationStages);
    expect(stages.map((s) => s.amount)).toEqual(['1500000.00', '2000000.00', '1500000.00']);
    expect(stages.every((s) => s.source === 'quotation' && s.sourceId === null)).toBe(true);
    expect(stages.map((s) => s.basisPercent)).toEqual(['30', '40', '30']);
    expect(scheduleTotal(stages)).toBe('5000000.00');
  });

  it('puts the rounding difference on the last stage', () => {
    const stages = scheduleFromQuotation('100.00', [
      { stageNo: 1, name: 'A', basis: 'percent', percent: '33.3333', amount: '0' },
      { stageNo: 2, name: 'B', basis: 'percent', percent: '33.3333', amount: '0' },
      { stageNo: 3, name: 'C', basis: 'percent', percent: '33.3334', amount: '0' },
    ]);
    expect(scheduleTotal(stages)).toBe('100.00');
    expect(stages.map((s) => s.amount)).toEqual(['33.33', '33.33', '33.34']);
  });

  it('keeps an amount stage as it is and has nothing to adjust when it already adds up', () => {
    const stages = scheduleFromQuotation('1000.00', [
      { stageNo: 1, name: 'Advance', basis: 'amount', percent: '25', amount: '250.00' },
      { stageNo: 2, name: 'Rest', basis: 'amount', percent: '75', amount: '750.00' },
    ]);
    expect(stages.map((s) => s.amount)).toEqual(['250.00', '750.00']);
    expect(stages.map((s) => s.basisPercent)).toEqual([null, null]);
  });

  it('gives an empty schedule for a quotation without stages', () => {
    expect(scheduleFromQuotation('1000.00', [])).toEqual([]);
  });

  it('adds one stage per approved variation with its price impact (BR-1)', () => {
    const stage = variationStage({
      stageNo: 4,
      number: 'P-0001-V1',
      priceImpact: '-250.5',
      variationId: 'v1',
    });
    expect(stage).toEqual({
      stageNo: 4,
      name: 'Variation P-0001-V1',
      basisPercent: null,
      amount: '-250.50',
      source: 'variation',
      sourceId: 'v1',
    });
    expect(nextStageNo([{ stageNo: 3 }, { stageNo: 1 }])).toBe(4);
    expect(nextStageNo([])).toBe(1);
  });

  it('blocks invoices while the sum differs from the contract value', () => {
    const stages = [{ amount: '600.00' }, { amount: '400.00' }];
    expect(() => assertScheduleMatchesContract(stages, '1000')).not.toThrow();
    expect(() => assertScheduleMatchesContract(stages, '1000.01')).toThrow(
      'adds up to 1000.00 but the contract value is 1000.01',
    );
  });

  describe('manual edit', () => {
    const planned: PlannedStage[] = [
      {
        id: 'a',
        stageNo: 2,
        name: 'Structure',
        basisPercent: '40',
        amount: '400.00',
        source: 'quotation',
        sourceId: null,
      },
    ];

    it('keeps the origin of a kept stage and marks new ones manual', () => {
      const result = applyScheduleEdit(
        planned,
        [1],
        [
          { id: 'a', stageNo: 2, name: ' Structure ', amount: '400' },
          { stageNo: 3, name: 'Extra', amount: '50.5' },
        ],
      );
      expect(result).toEqual([
        {
          stageNo: 2,
          name: 'Structure',
          basisPercent: '40',
          amount: '400.00',
          source: 'quotation',
          sourceId: null,
        },
        {
          stageNo: 3,
          name: 'Extra',
          basisPercent: null,
          amount: '50.50',
          source: 'manual',
          sourceId: null,
        },
      ]);
    });

    it('drops the percent of a kept stage whose amount changed', () => {
      const [stage] = applyScheduleEdit(
        planned,
        [],
        [{ id: 'a', stageNo: 2, name: 'S', amount: '450' }],
      );
      expect(stage?.basisPercent).toBeNull();
      expect(stage?.source).toBe('quotation');
    });

    it('refuses bad stage numbers, reused numbers, empty names and zero amounts', () => {
      const edit = (stageNo: number, name = 'X', amount = '10') =>
        applyScheduleEdit(planned, [1], [{ stageNo, name, amount }]);
      expect(() => edit(0)).toThrow('positive integer');
      expect(() => edit(1.5)).toThrow('positive integer');
      expect(() => edit(1)).toThrow('already used');
      expect(() => edit(5, '  ')).toThrow('needs a name');
      expect(() => edit(5, 'X', '0')).toThrow('cannot be zero');
      expect(() =>
        applyScheduleEdit(
          planned,
          [],
          [
            { stageNo: 2, name: 'A', amount: '1' },
            { stageNo: 2, name: 'B', amount: '1' },
          ],
        ),
      ).toThrow('already used');
    });
  });
});

describe('credit notes (T-6)', () => {
  // Base 1,000, advance recovery 100 taken, 10% tax charged on the full base at receipt.
  const atReceipt: CreditedInvoice = {
    baseAmount: '1000.00',
    advanceRecovery: '100.00',
    taxTotal: '100.00',
    taxOnAdvanceAtReceipt: true,
    taxGroups: [{ base: '1000.00', ratePercent: '10' }],
  };
  const none = { base: '0.00', advanceRestored: '0.00', tax: '0.00' };

  it('a full credit returns exactly the invoice: base, recovery, tax and gross', () => {
    const credit = computeCredit(atReceipt, none, '1000');
    expect(credit).toEqual({
      baseAmount: '1000.00',
      advanceRestored: '100.00',
      taxableBase: '1000.00',
      taxTotal: '100.00',
      grossTotal: '1000.00',
      complete: true,
    });
  });

  it('reverses tax with the stored rate on a part credit, and the rest on the final one', () => {
    const first = computeCredit(atReceipt, none, '400');
    expect([first.advanceRestored, first.taxTotal, first.grossTotal, first.complete]).toEqual([
      '40.00',
      '40.00',
      '400.00',
      false,
    ]);
    const final = computeCredit(
      atReceipt,
      { base: first.baseAmount, advanceRestored: first.advanceRestored, tax: first.taxTotal },
      '600',
    );
    expect([final.advanceRestored, final.taxTotal, final.grossTotal, final.complete]).toEqual([
      '60.00',
      '60.00',
      '600.00',
      true,
    ]);
  });

  it('when recovery reduced the taxable base, the credit does too', () => {
    const reduced: CreditedInvoice = {
      baseAmount: '1000.00',
      advanceRecovery: '100.00',
      taxTotal: '90.00',
      taxOnAdvanceAtReceipt: false,
      taxGroups: [{ base: '900.00', ratePercent: '10' }],
    };
    const part = computeCredit(reduced, none, '500');
    expect([part.advanceRestored, part.taxableBase, part.taxTotal, part.grossTotal]).toEqual([
      '50.00',
      '450.00',
      '45.00',
      '495.00',
    ]);
    const full = computeCredit(reduced, none, '1000');
    expect([full.taxableBase, full.taxTotal, full.grossTotal]).toEqual([
      '900.00',
      '90.00',
      '990.00',
    ]);
  });

  it('spreads the credit over several tax groups by their share of the base', () => {
    const two: CreditedInvoice = {
      baseAmount: '1000.00',
      advanceRecovery: '0.00',
      taxTotal: '130.00',
      taxOnAdvanceAtReceipt: true,
      taxGroups: [
        { base: '500.00', ratePercent: '10' },
        { base: '500.00', ratePercent: '16' },
      ],
    };
    // Half the base: 250 at 10% and 250 at 16% = 25 + 40 = 65.
    expect(computeCredit(two, none, '500').taxTotal).toBe('65.00');
  });

  it('charges no tax on a part credit of an invoice without tax', () => {
    const free: CreditedInvoice = { ...atReceipt, taxTotal: '0.00', taxGroups: [] };
    expect(computeCredit(free, none, '300').taxTotal).toBe('0.00');
  });

  it('never reverses more tax than is left', () => {
    const tight = computeCredit(
      atReceipt,
      { base: '0.00', advanceRestored: '0.00', tax: '99.99' },
      '500',
    );
    expect(tight.taxTotal).toBe('0.01');
  });

  it('never restores more advance than is left', () => {
    const credit = computeCredit(
      atReceipt,
      { base: '500.00', advanceRestored: '99.99', tax: '50.00' },
      '300',
    );
    expect(credit.advanceRestored).toBe('0.01');
  });

  it('refuses a credit above the creditable base or at or below zero', () => {
    expect(() => computeCredit(atReceipt, { ...none, base: '400.00' }, '600.01')).toThrow(
      'exceeds the 600.00 still creditable',
    );
    expect(() => computeCredit(atReceipt, none, '0')).toThrow('above zero');
    expect(() => computeCredit(atReceipt, none, '-5')).toThrow('above zero');
  });
});

describe('print model (T-8)', () => {
  const source: InvoicePrintSource = {
    company: { name: 'Synthetic Builders', address: 'Office 1', phone: null, email: null },
    registration: { authority: 'FBR', registrationType: 'strn', number: 'TEST-FBR-1' },
    client: { name: 'Client', address: null, city: 'Lahore', ntn: 'NTN-1', strn: null },
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
    taxOnAdvanceAtReceipt: true,
    taxableBase: '1000.00',
    taxGroups: [{ taxCode: 'ST', ratePercent: '10', base: '1000.00', tax: '100.00' }],
    taxTotal: '100.00',
    grossTotal: '1000.00',
    withholdingExpected: '50.00',
    paymentInstructions: 'Pay to account X',
  };

  it('lists the printable fields with the notes for recovery and withholding', () => {
    const model = buildInvoicePrintModel(source);
    expect(model.advanceNote).toContain('tax on the advance was charged');
    expect(model.withholdingNote).toBe('Tax expected to be withheld by the client: PKR 50.00');
    expect(model.taxNote).toBeNull();
    expect(model.taxLines).toEqual(source.taxGroups);
    expect(model.registration).toEqual(source.registration);
  });

  it('copies nothing that is not a print field, even when the source carries extra data', () => {
    const polluted = {
      ...source,
      notes: 'internal remark',
      tax: { rules: [{ id: 'rule-id-1' }] },
      approval: { by: 'owner' },
    } as InvoicePrintSource;
    const text = JSON.stringify(buildInvoicePrintModel(polluted));
    for (const secret of ['internal remark', 'rule-id-1', 'owner']) {
      expect(text).not.toContain(secret);
    }
  });

  it('states the other recovery mode, a tax-free invoice, and no withholding', () => {
    const model = buildInvoicePrintModel({
      ...source,
      taxOnAdvanceAtReceipt: false,
      taxGroups: [],
      taxTotal: '0.00',
      withholdingExpected: '0.00',
      registration: null,
    });
    expect(model.advanceNote).toContain('reduces the taxable base');
    expect(model.taxNote).toBe('No sales tax is charged on this invoice');
    expect(model.withholdingNote).toBeNull();
    expect(model.registration).toBeNull();
    expect(buildInvoicePrintModel({ ...source, advanceRecovery: '0.00' }).advanceNote).toBeNull();
  });
});
