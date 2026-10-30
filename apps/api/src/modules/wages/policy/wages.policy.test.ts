import { describe, expect, it } from 'vitest';
import {
  assertFound,
  assertHasLines,
  assertMonthFree,
  assertNotPaid,
  assertUpdated,
  missingRate,
} from './wages.policy.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('wages policy', () => {
  it('reports a missing record as not found and passes a found one', () => {
    expect(assertFound({ id: 1 }, 'period')).toEqual({ id: 1 });
    expect(codeOf(() => assertFound(undefined, 'period'))).toBe('period_not_found');
  });

  it('reports a moved version as a conflict (constitution 5.2)', () => {
    expect(assertUpdated({ id: 1 })).toEqual({ id: 1 });
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
  });

  it('allows one period per month', () => {
    expect(codeOf(() => assertMonthFree(undefined))).toBe('no error');
    expect(codeOf(() => assertMonthFree({ id: 'x' }))).toBe('period_exists');
  });

  it('names the worker and the date when a pay rate is missing', () => {
    const error = missingRate('Synthetic Worker 1', '2026-10-05');
    expect(error.code).toBe('worker_rate_missing');
    expect(error.message).toContain('Synthetic Worker 1');
    expect(error.message).toContain('2026-10-05');
  });

  it('refuses to submit an empty period (BR-11)', () => {
    expect(codeOf(() => assertHasLines(1))).toBe('no error');
    expect(codeOf(() => assertHasLines(0))).toBe('period_empty');
  });

  it('refuses to reopen a period with a paid line (BR-11)', () => {
    expect(codeOf(() => assertNotPaid(false))).toBe('no error');
    expect(codeOf(() => assertNotPaid(true))).toBe('period_paid');
  });
});
