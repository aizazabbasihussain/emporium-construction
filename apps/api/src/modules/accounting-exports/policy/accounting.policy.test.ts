import { accountingPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertAccountUsable,
  assertFound,
  assertMayManageRules,
  assertMayRead,
  assertMayRun,
  assertMayTag,
  assertMayView,
  assertPeriod,
  assertVersionMatched,
} from './accounting.policy.js';

const holding = (...codes: string[]) => ({ permissions: new Set(codes) });
const none = holding();

describe('accounting policy (spec section 6, BR-8)', () => {
  it('needs accounting.export.run to run an export', () => {
    expect(() => assertMayRun(holding(accountingPermissions.exportRun))).not.toThrow();
    expect(() => assertMayRun(holding(accountingPermissions.exportRead))).toThrow('Not allowed');
    expect(() => assertMayRun(none)).toThrow('Not allowed');
  });

  it('lets whoever reads or runs exports open the hub', () => {
    expect(() => assertMayRead(holding(accountingPermissions.exportRead))).not.toThrow();
    expect(() => assertMayRead(holding(accountingPermissions.exportRun))).not.toThrow();
    expect(() => assertMayRead(holding(accountingPermissions.tagManage))).toThrow('Not allowed');
    expect(() => assertMayRead(none)).toThrow('Not allowed');
  });

  it('lets anyone with an accounting permission see the queue, the rules and the chart', () => {
    for (const code of Object.values(accountingPermissions)) {
      expect(() => assertMayView(holding(code))).not.toThrow();
    }
    expect(() => assertMayView(none)).toThrow('Not allowed');
    expect(() => assertMayView(holding('billing.invoice.read'))).toThrow('Not allowed');
  });

  it('keeps tagging and rules to their own permission', () => {
    expect(() => assertMayTag(holding(accountingPermissions.tagManage))).not.toThrow();
    expect(() => assertMayTag(holding(accountingPermissions.rulesManage))).toThrow('Not allowed');
    expect(() => assertMayManageRules(holding(accountingPermissions.rulesManage))).not.toThrow();
    expect(() => assertMayManageRules(holding(accountingPermissions.tagManage))).toThrow(
      'Not allowed',
    );
  });

  it('reports a missing row as not found and a lost race as a conflict', () => {
    expect(assertFound({ id: 1 }, 'rule')).toEqual({ id: 1 });
    expect(() => assertFound(undefined, 'rule')).toThrow('Not found');
    expect(assertVersionMatched('row')).toBe('row');
    expect(() => assertVersionMatched(undefined)).toThrow('changed by someone else');
  });

  it('accepts only an existing, active account', () => {
    expect(() => assertAccountUsable({ active: true }, '4100')).not.toThrow();
    expect(() => assertAccountUsable({ active: false }, '4100')).toThrow('switched off');
    expect(() => assertAccountUsable(undefined, '4100')).toThrow('There is no account 4100');
  });

  it('accepts a period that starts on or before it ends', () => {
    expect(() => assertPeriod('2026-10-01', '2026-10-01')).not.toThrow();
    expect(() => assertPeriod('2026-10-02', '2026-10-01')).toThrow('starts after');
  });
});
