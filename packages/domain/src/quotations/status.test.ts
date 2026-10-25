import { describe, expect, it } from 'vitest';
import { RuleViolationError } from '../errors.js';
import {
  assertEditable,
  assertRevisable,
  assertTransition,
  quotationStatuses,
  quotationTransitions,
} from './status.js';

describe('quotation state machine (spec P1-08 T-3)', () => {
  const allowed = new Set([
    'draft>pending_approval',
    'pending_approval>approved',
    'pending_approval>draft',
    'approved>issued',
    'issued>accepted',
    'issued>rejected',
    'issued>expired',
    'issued>superseded',
    'rejected>superseded',
    'expired>superseded',
  ]);

  for (const from of quotationStatuses) {
    for (const to of quotationStatuses) {
      const ok = allowed.has(`${from}>${to}`);
      it(`${from} to ${to} is ${ok ? 'allowed' : 'forbidden'}`, () => {
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(RuleViolationError);
      });
    }
  }

  it('lists exactly the allowed transitions', () => {
    expect(Object.values(quotationTransitions).flat()).toHaveLength(allowed.size);
  });

  it('accepted and superseded are final', () => {
    expect(quotationTransitions.accepted).toEqual([]);
    expect(quotationTransitions.superseded).toEqual([]);
  });

  it('only a draft is editable (BR-4)', () => {
    for (const status of quotationStatuses) {
      if (status === 'draft') expect(() => assertEditable(status)).not.toThrow();
      else expect(() => assertEditable(status)).toThrow(RuleViolationError);
    }
  });

  it('only issued, rejected and expired quotations can be revised (BR-4, BR-10)', () => {
    const revisable = new Set(['issued', 'rejected', 'expired']);
    for (const status of quotationStatuses) {
      if (revisable.has(status)) expect(() => assertRevisable(status)).not.toThrow();
      else expect(() => assertRevisable(status)).toThrow(RuleViolationError);
    }
  });
});
