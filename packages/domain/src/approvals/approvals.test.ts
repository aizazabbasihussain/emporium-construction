import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors.js';
import {
  allowedTransitions,
  assertOpen,
  assertTransition,
  canTransition,
  decide,
  requestStatuses,
  selectBand,
  validateBands,
  validateSteps,
  type DecideInput,
  type StepDef,
} from './index.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).code;
  }
  return 'no_error';
};

describe('band validation (T-6)', () => {
  it('accepts contiguous bands starting at 0 with an open top band', () => {
    expect(() =>
      validateBands([
        { minAmount: '50000', maxAmount: null },
        { minAmount: '0', maxAmount: '50000' },
      ]),
    ).not.toThrow();
  });

  it('accepts a single bounded band', () => {
    expect(() => validateBands([{ minAmount: '0', maxAmount: '100.00' }])).not.toThrow();
  });

  it('rejects an empty list', () => {
    expect(codeOf(() => validateBands([]))).toBe('bands_empty');
  });

  it('rejects a gap at the start and between bands', () => {
    expect(codeOf(() => validateBands([{ minAmount: '10', maxAmount: null }]))).toBe('band_gap');
    expect(
      codeOf(() =>
        validateBands([
          { minAmount: '0', maxAmount: '100' },
          { minAmount: '200', maxAmount: null },
        ]),
      ),
    ).toBe('band_gap');
  });

  it('rejects overlapping bands, including anything after an open band', () => {
    expect(
      codeOf(() =>
        validateBands([
          { minAmount: '0', maxAmount: '100' },
          { minAmount: '50', maxAmount: null },
        ]),
      ),
    ).toBe('band_overlap');
    expect(
      codeOf(() =>
        validateBands([
          { minAmount: '0', maxAmount: null },
          { minAmount: '100', maxAmount: null },
        ]),
      ),
    ).toBe('band_overlap');
  });

  it('rejects negative amounts and empty bands', () => {
    expect(codeOf(() => validateBands([{ minAmount: '-1', maxAmount: '5' }]))).toBe(
      'band_negative',
    );
    expect(codeOf(() => validateBands([{ minAmount: '0', maxAmount: '-5' }]))).toBe(
      'band_negative',
    );
    expect(codeOf(() => validateBands([{ minAmount: '0', maxAmount: '0' }]))).toBe('band_empty');
  });

  it('rejects text that is not an amount', () => {
    expect(codeOf(() => validateBands([{ minAmount: 'abc', maxAmount: null }]))).toBe(
      'invalid_amount',
    );
  });
});

describe('band selection (T-1)', () => {
  const bands = [
    { minAmount: '0', maxAmount: '1000', id: 'low' },
    { minAmount: '1000', maxAmount: '5000', id: 'mid' },
    { minAmount: '5000', maxAmount: null, id: 'high' },
  ];

  it('includes the minimum and excludes the maximum', () => {
    expect(selectBand(bands, '0')?.id).toBe('low');
    expect(selectBand(bands, '999.99')?.id).toBe('low');
    expect(selectBand(bands, '1000')?.id).toBe('mid');
    expect(selectBand(bands, '4999.99')?.id).toBe('mid');
    expect(selectBand(bands, '5000')?.id).toBe('high');
    expect(selectBand(bands, '999999999')?.id).toBe('high');
  });

  it('returns nothing when no band contains the amount', () => {
    expect(selectBand([{ minAmount: '0', maxAmount: '10' }], '10')).toBeUndefined();
    expect(selectBand([], '1')).toBeUndefined();
  });

  it('rejects negative and malformed amounts', () => {
    expect(codeOf(() => selectBand(bands, '-1'))).toBe('amount_negative');
    expect(codeOf(() => selectBand(bands, 'x'))).toBe('invalid_amount');
  });
});

describe('step validation', () => {
  const ok: StepDef[] = [
    { stepNo: 1, roleCode: 'a', minApprovers: 1 },
    { stepNo: 2, roleCode: 'b', minApprovers: 2 },
  ];

  it('accepts ordered steps', () => {
    expect(() => validateSteps(ok)).not.toThrow();
  });

  it('rejects bad steps', () => {
    expect(codeOf(() => validateSteps([]))).toBe('steps_empty');
    expect(codeOf(() => validateSteps([{ stepNo: 2, roleCode: 'a', minApprovers: 1 }]))).toBe(
      'steps_not_sequential',
    );
    expect(codeOf(() => validateSteps([{ stepNo: 1, roleCode: ' ', minApprovers: 1 }]))).toBe(
      'step_role_required',
    );
    expect(codeOf(() => validateSteps([{ stepNo: 1, roleCode: 'a', minApprovers: 0 }]))).toBe(
      'step_approvers_invalid',
    );
    expect(codeOf(() => validateSteps([{ stepNo: 1, roleCode: 'a', minApprovers: 1.5 }]))).toBe(
      'step_approvers_invalid',
    );
  });
});

describe('state machine (T-3)', () => {
  it('allows exactly the listed transitions and no others', () => {
    for (const from of requestStatuses) {
      for (const to of requestStatuses) {
        const expected = from === 'pending' && to !== 'pending';
        expect(canTransition(from, to)).toBe(expected);
        if (expected) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(codeOf(() => assertTransition(from, to))).toBe('request_not_pending');
      }
    }
  });

  it('only a pending request is open', () => {
    expect(() => assertOpen('pending')).not.toThrow();
    for (const status of requestStatuses.filter((s) => s !== 'pending')) {
      expect(codeOf(() => assertOpen(status))).toBe('request_not_pending');
    }
  });

  it('lists every status', () => {
    expect(Object.keys(allowedTransitions).sort()).toEqual([...requestStatuses].sort());
  });
});

describe('decide (T-2, T-4)', () => {
  const steps: StepDef[] = [
    { stepNo: 1, roleCode: 'pm', minApprovers: 2 },
    { stepNo: 2, roleCode: 'owner', minApprovers: 1 },
  ];
  const base: DecideInput = {
    steps,
    currentStep: 1,
    requesterId: 'req',
    actorId: 'u1',
    actorRoles: ['pm'],
    action: 'approve',
    comment: null,
    history: [],
  };

  it('needs min_approvers distinct users before the step completes', () => {
    expect(decide(base)).toEqual({ status: 'pending', currentStep: 1 });
    const second = decide({
      ...base,
      actorId: 'u2',
      history: [{ stepNo: 1, actorId: 'u1', action: 'approve' }],
    });
    expect(second).toEqual({ status: 'pending', currentStep: 2 });
  });

  it('approves after the last step', () => {
    expect(
      decide({
        ...base,
        currentStep: 2,
        actorId: 'o',
        actorRoles: ['owner'],
        history: [
          { stepNo: 1, actorId: 'u1', action: 'approve' },
          { stepNo: 1, actorId: 'u2', action: 'approve' },
        ],
      }),
    ).toEqual({ status: 'approved', currentStep: 2 });
  });

  it('rejects the same approver twice and the same user on two steps', () => {
    expect(
      codeOf(() => decide({ ...base, history: [{ stepNo: 1, actorId: 'u1', action: 'approve' }] })),
    ).toBe('already_approved');
    expect(
      codeOf(() =>
        decide({
          ...base,
          currentStep: 2,
          actorId: 'u1',
          actorRoles: ['pm', 'owner'],
          history: [
            { stepNo: 1, actorId: 'u1', action: 'approve' },
            { stepNo: 1, actorId: 'u2', action: 'approve' },
          ],
        }),
      ),
    ).toBe('already_approved');
  });

  it('blocks the requester even when they hold the role', () => {
    for (const action of ['approve', 'reject', 'return'] as const) {
      expect(codeOf(() => decide({ ...base, actorId: 'req', action, comment: 'because' }))).toBe(
        'self_approval',
      );
    }
  });

  it('blocks a user without the step role', () => {
    expect(codeOf(() => decide({ ...base, actorRoles: ['owner'] }))).toBe('not_an_approver');
  });

  it('reject and return end the request and need a comment', () => {
    expect(decide({ ...base, action: 'reject', comment: 'too dear' })).toEqual({
      status: 'rejected',
      currentStep: 1,
    });
    expect(decide({ ...base, action: 'return', comment: 'fix qty' })).toEqual({
      status: 'returned',
      currentStep: 1,
    });
    for (const action of ['reject', 'return'] as const) {
      expect(codeOf(() => decide({ ...base, action, comment: null }))).toBe('comment_required');
      expect(codeOf(() => decide({ ...base, action, comment: '  ' }))).toBe('comment_required');
    }
  });

  it('fails when the current step does not exist', () => {
    expect(codeOf(() => decide({ ...base, currentStep: 9 }))).toBe('step_not_found');
  });

  it('lets someone who approved reject or return later', () => {
    expect(
      decide({
        ...base,
        action: 'reject',
        comment: 'changed my mind',
        history: [{ stepNo: 1, actorId: 'u1', action: 'approve' }],
      }).status,
    ).toBe('rejected');
  });
});
