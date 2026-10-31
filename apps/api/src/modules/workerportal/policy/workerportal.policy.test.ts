import { describe, expect, it } from 'vitest';
import {
  assertLinkableRoles,
  assertLinked,
  assertPortalAccess,
  assertUserFree,
  hasPortalAccess,
  monthsBack,
  parseMonth,
} from './workerportal.policy.js';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('assertLinked (BR-2)', () => {
  it('returns the link and refuses a login with none', () => {
    expect(assertLinked({ worker_id: 'w' })).toEqual({ worker_id: 'w' });
    expect(codeOf(() => assertLinked(undefined))).toBe('no_worker_link');
  });
});

describe('access of a worker who has left (BR-4)', () => {
  it.each([
    [null, '2026-10-25', true],
    ['2026-10-26', '2026-10-25', true],
    ['2026-10-25', '2026-10-25', true],
    ['2026-10-24', '2026-10-25', false],
  ])('left %s on %s -> %s', (leftOn, today, allowed) => {
    expect(hasPortalAccess(leftOn, today)).toBe(allowed);
    expect(codeOf(() => assertPortalAccess(leftOn, today))).toBe(
      allowed ? undefined : 'worker_left',
    );
  });
});

describe('assertLinkableRoles (BR-1)', () => {
  it('lets a login holding only the worker role through', () => {
    expect(codeOf(() => assertLinkableRoles(['worker'], false))).toBeUndefined();
  });

  it.each([[['worker', 'supervisor']], [['supervisor']], [[]]])(
    'asks for confirmation when the roles are %j',
    (roles) => {
      expect(codeOf(() => assertLinkableRoles(roles, false))).toBe('user_has_other_roles');
      expect(codeOf(() => assertLinkableRoles(roles, true))).toBeUndefined();
    },
  );
});

describe('assertUserFree', () => {
  it('refuses a user who belongs to another worker only', () => {
    expect(codeOf(() => assertUserFree(undefined, 'w1'))).toBeUndefined();
    expect(codeOf(() => assertUserFree('w1', 'w1'))).toBeUndefined();
    expect(codeOf(() => assertUserFree('w2', 'w1'))).toBe('user_already_linked');
  });
});

describe('parseMonth', () => {
  it('turns yyyy-mm into the first and last day', () => {
    expect(parseMonth('2026-10')).toEqual({
      year: 2026,
      month: 10,
      key: '2026-10',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(parseMonth('2028-02').to).toBe('2028-02-29');
    expect(parseMonth('2026-02').to).toBe('2026-02-28');
  });

  it.each(['', '2026-1', '2026-13', '2026-00', '1999-12', '2101-01', 'abc', '2026-10-01'])(
    'rejects %j',
    (text) => {
      expect(codeOf(() => parseMonth(text))).toBe('invalid_month');
    },
  );
});

describe('monthsBack', () => {
  it('lists the months newest first across a year end', () => {
    expect(monthsBack({ year: 2026, month: 2 }, 4)).toEqual([
      { year: 2026, month: 2 },
      { year: 2026, month: 1 },
      { year: 2025, month: 12 },
      { year: 2025, month: 11 },
    ]);
    expect(monthsBack({ year: 2026, month: 2 }, 0)).toEqual([]);
  });
});
