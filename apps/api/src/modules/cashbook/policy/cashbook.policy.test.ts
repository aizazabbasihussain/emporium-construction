import { describe, expect, it } from 'vitest';
import {
  assertAccountActive,
  assertAccountUnused,
  assertApproved,
  assertDifferentAccounts,
  assertDraft,
  assertFound,
  assertLinesInPeriod,
  assertMasked,
  assertMatchable,
  assertOpeningBalance,
  assertOverdraftFlagAllowed,
  assertPending,
  assertPeriod,
  assertReversalDate,
  assertUpdated,
  normalizeTag,
  requiresApproval,
} from './cashbook.policy.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'none';
};

describe('cashbook policy', () => {
  it('reports a missing record as not found and a lost update as a version conflict', () => {
    expect(assertFound({ a: 1 }, 'account')).toEqual({ a: 1 });
    expect(code(() => assertFound(undefined, 'account'))).toBe('account_not_found');
    expect(assertUpdated('row')).toBe('row');
    expect(code(() => assertUpdated(undefined))).toBe('version_conflict');
  });

  it('accepts only a masked account number', () => {
    expect(code(() => assertMasked(null))).toBe('none');
    expect(code(() => assertMasked('****1234'))).toBe('none');
    expect(code(() => assertMasked('12345'))).toBe('account_number_not_masked');
  });

  it('opening balances: negative only for an overdraft-capable bank account or wallet', () => {
    const check = (
      kind: 'cash' | 'bank' | 'petty_cash' | 'wallet',
      allow: boolean,
      amount: string,
    ) => code(() => assertOpeningBalance({ kind, allowOverdraft: allow, openingBalance: amount }));
    expect(check('cash', false, '0')).toBe('none');
    expect(check('cash', false, '-1')).toBe('opening_balance_negative');
    expect(check('petty_cash', true, '-1')).toBe('opening_balance_negative');
    expect(check('bank', false, '-1')).toBe('opening_balance_negative');
    expect(check('bank', true, '-1')).toBe('none');
    expect(check('wallet', true, '-1')).toBe('none');
  });

  it('the overdraft flag never applies to cash or petty cash', () => {
    expect(code(() => assertOverdraftFlagAllowed('cash', true))).toBe('overdraft_not_allowed');
    expect(code(() => assertOverdraftFlagAllowed('petty_cash', true))).toBe(
      'overdraft_not_allowed',
    );
    expect(code(() => assertOverdraftFlagAllowed('cash', false))).toBe('none');
    expect(code(() => assertOverdraftFlagAllowed('bank', true))).toBe('none');
  });

  it('guards deletion, activity and transfers', () => {
    expect(code(() => assertAccountUnused(0))).toBe('none');
    expect(code(() => assertAccountUnused(2))).toBe('account_in_use');
    expect(code(() => assertAccountActive(true))).toBe('none');
    expect(code(() => assertAccountActive(false))).toBe('account_inactive');
    expect(code(() => assertDifferentAccounts('a', 'b'))).toBe('none');
    expect(code(() => assertDifferentAccounts('a', 'a'))).toBe('transfer_same_account');
  });

  it('normalizes tags', () => {
    expect(normalizeTag(undefined)).toBeNull();
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag('  ')).toBeNull();
    expect(normalizeTag(' 1010 ')).toBe('1010');
    expect(code(() => normalizeTag('x'.repeat(41)))).toBe('tag_invalid');
  });

  it('needs approval only strictly above the threshold', () => {
    expect(requiresApproval('0.01', '0')).toBe(true);
    expect(requiresApproval('50', '50')).toBe(false);
    expect(requiresApproval('50.01', '50')).toBe(true);
  });

  describe('assertApproved (BR-5, H-09)', () => {
    const facts = {
      status: 'approved',
      amount: '100.00',
      approvers: ['owner'],
      alreadyPaid: '40.00',
    };
    const run = (over: Partial<Parameters<typeof assertApproved>[0]>) =>
      code(() =>
        assertApproved({
          approvalDocId: 'doc',
          facts,
          amount: '60',
          actorUserId: 'accountant',
          ...over,
        }),
      );

    it('accepts an approved request that still covers the amount', () => {
      expect(run({})).toBe('none');
      expect(run({ actorUserId: null })).toBe('none');
    });

    it('refuses a missing id, an unknown request, an undecided request and the approver as recorder', () => {
      expect(run({ approvalDocId: undefined })).toBe('approval_required');
      expect(run({ facts: undefined })).toBe('approval_not_found');
      expect(run({ facts: { ...facts, status: 'pending' } })).toBe('approval_not_approved');
      expect(run({ actorUserId: 'owner' })).toBe('approver_cannot_record');
    });

    it('refuses an amount above what is left of the approval', () => {
      expect(run({ amount: '60.01' })).toBe('approval_amount_exceeded');
    });
  });

  it('checks dates and periods', () => {
    expect(code(() => assertReversalDate('2026-11-02', '2026-11-01'))).toBe('none');
    expect(code(() => assertReversalDate('2026-11-01', '2026-11-01'))).toBe('none');
    expect(code(() => assertReversalDate('2026-10-31', '2026-11-01'))).toBe(
      'reversal_before_original',
    );
    expect(code(() => assertPeriod('2026-11-01', '2026-11-01'))).toBe('none');
    expect(code(() => assertPeriod('2026-11-02', '2026-11-01'))).toBe('period_invalid');
    const lines = (dates: string[]) => dates.map((lineDate) => ({ lineDate }));
    expect(
      code(() =>
        assertLinesInPeriod(lines(['2026-11-01', '2026-11-30']), '2026-11-01', '2026-11-30'),
      ),
    ).toBe('none');
    expect(code(() => assertLinesInPeriod(lines(['2026-10-31']), '2026-11-01', '2026-11-30'))).toBe(
      'statement_line_out_of_period',
    );
    expect(code(() => assertLinesInPeriod(lines(['2026-12-01']), '2026-11-01', '2026-11-30'))).toBe(
      'statement_line_out_of_period',
    );
  });

  it('reconciliation and pending-source states', () => {
    expect(code(() => assertDraft('draft'))).toBe('none');
    expect(code(() => assertDraft('completed'))).toBe('reconciliation_not_draft');
    expect(code(() => assertPending('pending'))).toBe('none');
    expect(code(() => assertPending('recorded'))).toBe('source_already_recorded');
  });

  it('matches a statement line to a transaction only on direction and amount', () => {
    const line = { direction: 'in', amount: '10.00' };
    expect(code(() => assertMatchable(line, { direction: 'in', amount: '10' }))).toBe('none');
    expect(code(() => assertMatchable(line, { direction: 'out', amount: '10' }))).toBe(
      'match_mismatch',
    );
    expect(code(() => assertMatchable(line, { direction: 'in', amount: '11' }))).toBe(
      'match_mismatch',
    );
  });
});
