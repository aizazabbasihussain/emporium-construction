import { describe, expect, it } from 'vitest';
import { BusinessDate } from '../kernel/business-date.js';
import {
  assertCopyable,
  assertEditable,
  assertInternallyApproved,
  approvalAmount,
  assertTransition,
  budgetLines,
  isOpenStatus,
  atRisk,
  checkClientApproval,
  currentContractValue,
  impactTotals,
  normalizeLines,
  variationNumber,
  variationStatuses,
  variationTransitions,
  type LedgerRow,
  type VariationStatus,
} from './index.js';

const line = (over: Partial<Parameters<typeof normalizeLines>[0][number]> = {}) => ({
  description: 'Extra excavation',
  costCodeId: 'code-1',
  costAmount: '100',
  priceAmount: '150',
  ...over,
});

describe('variation lines and totals (BR-2, T-1)', () => {
  it('numbers the lines, trims and fixes two decimals', () => {
    expect(normalizeLines([line({ description: '  Dig ' }), line({ costAmount: '2.5' })])).toEqual([
      {
        lineNo: 1,
        description: 'Dig',
        costCodeId: 'code-1',
        costAmount: '100.00',
        priceAmount: '150.00',
      },
      {
        lineNo: 2,
        description: 'Extra excavation',
        costCodeId: 'code-1',
        costAmount: '2.50',
        priceAmount: '150.00',
      },
    ]);
  });

  it('needs at least one line', () => {
    expect(() => normalizeLines([])).toThrow(expect.objectContaining({ code: 'lines_required' }));
  });

  it('needs a description', () => {
    expect(() => normalizeLines([line({ description: '   ' })])).toThrow(
      expect.objectContaining({ code: 'description_required' }),
    );
  });

  it('refuses a negative cost but allows a negative price', () => {
    expect(() => normalizeLines([line({ costAmount: '-1' })])).toThrow(
      expect.objectContaining({ code: 'cost_amount_negative' }),
    );
    expect(normalizeLines([line({ priceAmount: '-40.5' })])[0]?.priceAmount).toBe('-40.50');
  });

  it('refuses amounts that are not money', () => {
    expect(() => normalizeLines([line({ priceAmount: '1.234' })])).toThrow(
      expect.objectContaining({ code: 'price_amount_invalid' }),
    );
    expect(() => normalizeLines([line({ costAmount: 'abc' })])).toThrow(
      expect.objectContaining({ code: 'cost_amount_invalid' }),
    );
  });

  it('sums price and cost, including negative price lines', () => {
    const lines = normalizeLines([
      line({ costAmount: '100.10', priceAmount: '150.20' }),
      line({ costAmount: '0', priceAmount: '-60.05' }),
      line({ costAmount: '20', priceAmount: '0' }),
    ]);
    expect(impactTotals(lines)).toEqual({ priceImpact: '90.15', costImpact: '120.10' });
    expect(impactTotals([])).toEqual({ priceImpact: '0.00', costImpact: '0.00' });
  });
});

describe('current contract value (BR-5, T-3)', () => {
  it('adds the approved impacts, including a deductive one, to the original', () => {
    expect(currentContractValue('1000000.00', ['250000.50', '-100000.25', '0.00'])).toBe(
      '1150000.25',
    );
  });

  it('is the original when nothing is approved', () => {
    expect(currentContractValue('1000000', [])).toBe('1000000.00');
  });
});

describe('state machine (T-2)', () => {
  const allowed: [VariationStatus, VariationStatus][] = [
    ['draft', 'pending_internal_approval'],
    ['draft', 'cancelled'],
    ['pending_internal_approval', 'submitted_to_client'],
    ['pending_internal_approval', 'cancelled'],
    ['submitted_to_client', 'client_approved'],
    ['submitted_to_client', 'client_rejected'],
    ['submitted_to_client', 'cancelled'],
  ];

  it.each(variationStatuses.flatMap((from) => variationStatuses.map((to) => [from, to] as const)))(
    '%s to %s',
    (from, to) => {
      const isAllowed = allowed.some(([a, b]) => a === from && b === to);
      if (isAllowed) {
        expect(() => assertTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertTransition(from, to)).toThrow(
          expect.objectContaining({ code: 'variation_transition' }),
        );
      }
    },
  );

  it('lists exactly the allowed transitions', () => {
    expect(Object.values(variationTransitions).flat()).toHaveLength(allowed.length);
  });

  it('only a draft is editable; the approved case has its own message (BR-6)', () => {
    expect(() => assertEditable('draft')).not.toThrow();
    for (const status of variationStatuses.filter((s) => s !== 'draft')) {
      expect(() => assertEditable(status)).toThrow(
        expect.objectContaining({ code: 'variation_read_only' }),
      );
    }
    expect(() => assertEditable('client_approved')).toThrow(/deductive/);
    expect(() => assertEditable('cancelled')).toThrow(/Only a draft/);
  });

  it('only a client-rejected variation can be copied (BR-7)', () => {
    expect(() => assertCopyable('client_rejected')).not.toThrow();
    for (const status of variationStatuses.filter((s) => s !== 'client_rejected')) {
      expect(() => assertCopyable(status)).toThrow(
        expect.objectContaining({ code: 'variation_not_copyable' }),
      );
    }
  });
});

describe('internal approval before the client (BR-3, AC-2)', () => {
  it('passes only for an approved request', () => {
    expect(() => assertInternallyApproved('approved')).not.toThrow();
    for (const status of ['none', 'pending', 'rejected', 'returned', 'cancelled']) {
      expect(() => assertInternallyApproved(status)).toThrow(
        expect.objectContaining({ code: 'internal_approval_required' }),
      );
    }
  });
});

describe('client approval (BR-4)', () => {
  const today = BusinessDate.parse('2026-10-25');
  const ok = { reference: ' LTR-7 ', approvedOn: '2026-10-25', hasDocument: true };

  it('accepts a reference, a date up to today and a document', () => {
    expect(checkClientApproval(ok, today)).toEqual({
      reference: 'LTR-7',
      approvedOn: '2026-10-25',
    });
    expect(checkClientApproval({ ...ok, approvedOn: '2026-01-01' }, today).approvedOn).toBe(
      '2026-01-01',
    );
  });

  it('needs a reference', () => {
    for (const reference of [undefined, null, '', '  ']) {
      expect(() => checkClientApproval({ ...ok, reference }, today)).toThrow(
        expect.objectContaining({ code: 'client_reference_required' }),
      );
    }
  });

  it('needs a date that is real and not in the future', () => {
    for (const approvedOn of [undefined, null]) {
      expect(() => checkClientApproval({ ...ok, approvedOn }, today)).toThrow(
        expect.objectContaining({ code: 'client_date_required' }),
      );
    }
    expect(() => checkClientApproval({ ...ok, approvedOn: '2026-10-26' }, today)).toThrow(
      expect.objectContaining({ code: 'client_date_future' }),
    );
    expect(() => checkClientApproval({ ...ok, approvedOn: '2026-02-30' }, today)).toThrow(
      expect.objectContaining({ code: 'invalid_date' }),
    );
  });

  it('needs the attached document', () => {
    expect(() => checkClientApproval({ ...ok, hasDocument: false }, today)).toThrow(
      expect.objectContaining({ code: 'client_document_required' }),
    );
  });
});

describe('variation number (BR-1)', () => {
  it('is the project code, V and the sequence', () => {
    expect(variationNumber('PRJ-0007', 3)).toBe('PRJ-0007-V3');
  });
});

describe('at risk (BR-8, T-5)', () => {
  const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
    sourceModule: 'procurement',
    sourceDocType: 'grn',
    sourceDocId: 'doc-1',
    sourceLineId: 'l-1',
    costCodeId: 'c-100',
    amount: '1000.00',
    status: 'posted',
    entryDate: '2026-10-10',
    ...over,
  });
  const open = { status: 'draft', discoveredOn: '2026-10-10', costCodeIds: ['c-100', 'c-200'] };

  it('sums approved and posted costs of matching codes on or after the discovery date', () => {
    const rows = [
      row(),
      row({ sourceDocId: 'doc-2', costCodeId: 'c-200', amount: '250.50', status: 'approved' }),
      row({ sourceDocId: 'doc-3', entryDate: '2026-10-09' }),
      row({ sourceDocId: 'doc-4', costCodeId: 'c-999' }),
      row({ sourceDocId: 'doc-5', status: 'committed' }),
      row({ sourceDocId: 'doc-6', amount: '10.00', entryDate: '2026-10-24' }),
    ];
    expect(atRisk(open, rows)).toEqual({
      total: '1260.50',
      byCostCode: [
        { costCodeId: 'c-100', amount: '1010.00' },
        { costCodeId: 'c-200', amount: '250.50' },
      ],
    });
  });

  it('uses only the newest row of a chain and drops a reversed chain', () => {
    const rows = [
      row({ status: 'posted', amount: '700.00', entryDate: '2026-10-20' }),
      row({ status: 'approved', amount: '700.00', entryDate: '2026-10-12' }),
      row({ sourceDocId: 'gone', status: 'reversed' }),
      row({ sourceDocId: 'gone', status: 'posted' }),
    ];
    expect(atRisk(open, rows).total).toBe('700.00');
  });

  it('is zero for a variation that is already decided', () => {
    for (const status of ['client_approved', 'client_rejected', 'cancelled']) {
      expect(atRisk({ ...open, status }, [row()])).toEqual({ total: '0.00', byCostCode: [] });
    }
  });

  it('counts for pending and submitted variations too', () => {
    for (const status of ['pending_internal_approval', 'submitted_to_client']) {
      expect(atRisk({ ...open, status }, [row()]).total).toBe('1000.00');
    }
    expect(atRisk(open, [])).toEqual({ total: '0.00', byCostCode: [] });
  });
});

describe('approval amount and budget lines', () => {
  it('submits a deductive variation at the size of its price impact', () => {
    expect(approvalAmount('-1500.5')).toBe('1500.50');
    expect(approvalAmount('2000')).toBe('2000.00');
  });

  it('adds a budget line only for lines that cost something (BR-5)', () => {
    const lines = normalizeLines([
      line({ description: 'Dig', costAmount: '100' }),
      line({ description: 'Credit', costAmount: '0', priceAmount: '-50' }),
      line({ description: 'Fill', costCodeId: 'code-2', costAmount: '12.5' }),
    ]);
    expect(budgetLines('PRJ-0001-V2', lines)).toEqual([
      { costCodeId: 'code-1', description: 'PRJ-0001-V2 L1: Dig', budgetAmount: '100.00' },
      { costCodeId: 'code-2', description: 'PRJ-0001-V2 L3: Fill', budgetAmount: '12.50' },
    ]);
  });

  it('knows which statuses are still open', () => {
    expect(variationStatuses.filter(isOpenStatus)).toEqual([
      'draft',
      'pending_internal_approval',
      'submitted_to_client',
    ]);
  });
});
