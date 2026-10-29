import { describe, expect, it } from 'vitest';
import {
  assertAny,
  assertApplied,
  assertCancelable,
  assertCanCancel,
  assertCanReadBalance,
  assertCanReadClaim,
  assertCategoryKnown,
  assertCostCodeActive,
  assertCustodianUsable,
  assertDraftOnly,
  assertFound,
  assertOwnClaim,
  assertProjectActive,
  assertProjectReachable,
  assertReceiptKnown,
  assertReversible,
  assertUpdated,
  assertUserKnown,
  canAccessReceipt,
  canReadClaim,
  canSeeAllCustodians,
} from './expenses.policy.js';

const perms = (...codes: string[]) => new Set(codes);
const code = (error: string) => expect.objectContaining({ code: error }) as Error;

describe('lookups and versions', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound('x', 'claim')).toBe('x');
    expect(() => assertFound(undefined, 'claim')).toThrow(code('claim_not_found'));
  });

  it('reports a moved version as a conflict', () => {
    expect(assertUpdated('row')).toBe('row');
    expect(() => assertUpdated(undefined)).toThrow(code('version_conflict'));
    expect(() => assertApplied(true)).not.toThrow();
    expect(() => assertApplied(false)).toThrow(code('version_conflict'));
  });
});

describe('references on a line', () => {
  it('limits a supervisor to the projects assigned to them', () => {
    const supervisor = { roles: ['supervisor'], scopes: [{ type: 'project' as const, id: 'p1' }] };
    expect(() => assertProjectReachable(supervisor, 'p1')).not.toThrow();
    expect(() => assertProjectReachable(supervisor, 'p2')).toThrow(code('project_not_found'));
    expect(() =>
      assertProjectReachable({ roles: ['project_manager'], scopes: [] }, 'p2'),
    ).not.toThrow();
  });

  it('wants an active project, an active cost code, a known category and receipt', () => {
    expect(() => assertProjectActive('active')).not.toThrow();
    for (const status of ['planning', 'on_hold', 'completed', 'closed', 'cancelled']) {
      expect(() => assertProjectActive(status), status).toThrow(code('project_not_active'));
    }
    expect(() => assertCostCodeActive(true)).not.toThrow();
    expect(() => assertCostCodeActive(false)).toThrow(code('cost_code_inactive'));
    expect(() => assertCategoryKnown(true)).not.toThrow();
    expect(() => assertCategoryKnown(false)).toThrow(code('category_unknown'));
    expect(() => assertReceiptKnown(true)).not.toThrow();
    expect(() => assertReceiptKnown(false)).toThrow(code('receipt_unknown'));
    expect(() => assertUserKnown(true)).not.toThrow();
    expect(() => assertUserKnown(false)).toThrow(code('user_unknown'));
  });
});

describe('who sees and changes a claim (spec section 6)', () => {
  const claimant = {
    userId: 'u1',
    permissions: perms('expenses.claim.create', 'expenses.claim.read_own'),
  };
  const readOnly = { userId: 'u1', permissions: perms('expenses.claim.read_own') };
  const creator = { userId: 'u1', permissions: perms('expenses.claim.create') };
  const finance = { userId: 'u9', permissions: perms('expenses.claim.read_all') };
  const stranger = {
    userId: 'u3',
    permissions: perms('expenses.claim.read_own', 'expenses.claim.create'),
  };
  const nobody = { userId: 'u1', permissions: perms() };

  it('shows a claimant their own claims and finance every claim', () => {
    expect(canReadClaim(claimant, 'u1')).toBe(true);
    expect(canReadClaim(readOnly, 'u1')).toBe(true);
    expect(canReadClaim(creator, 'u1')).toBe(true);
    expect(canReadClaim(stranger, 'u1')).toBe(false);
    expect(canReadClaim(finance, 'u1')).toBe(true);
    expect(canReadClaim(nobody, 'u1')).toBe(false);
  });

  it('reports a claim the caller may not see as not found', () => {
    const caller = { ...stranger, roles: [], scopes: [] };
    expect(() => assertCanReadClaim(caller, 'u1')).toThrow(code('claim_not_found'));
    expect(() => assertCanReadClaim({ ...finance, roles: [], scopes: [] }, 'u1')).not.toThrow();
  });

  it('lets only the claimant change a claim', () => {
    expect(() => assertOwnClaim(claimant, 'u1')).not.toThrow();
    expect(() => assertOwnClaim(finance, 'u1')).toThrow(code('not_your_claim'));
  });

  it('lets the claimant or the accountant cancel', () => {
    expect(() => assertCanCancel(claimant, 'u1')).not.toThrow();
    expect(() => assertCanCancel(stranger, 'u1')).toThrow(code('not_your_claim'));
    const accountant = { userId: 'u9', permissions: perms('expenses.claim.reverse') };
    expect(() => assertCanCancel(accountant, 'u1')).not.toThrow();
  });

  it('keeps posted claims for reversal only', () => {
    expect(() => assertCancelable('approved')).not.toThrow();
    expect(() => assertCancelable('posted')).toThrow(code('claim_posted'));
    expect(() => assertReversible('posted')).not.toThrow();
    expect(() => assertReversible('approved')).toThrow(code('claim_not_posted'));
    expect(() => assertDraftOnly('draft')).not.toThrow();
    expect(() => assertDraftOnly('returned')).toThrow(code('claim_not_draft'));
  });

  it('asks for any one of several permissions', () => {
    expect(() =>
      assertAny(claimant, ['expenses.advance.issue', 'expenses.claim.create']),
    ).not.toThrow();
    expect(() => assertAny(claimant, ['expenses.advance.issue'])).toThrow(code('forbidden'));
  });
});

describe('advances and custodians', () => {
  it('shows finance every custodian and a claimant only themselves', () => {
    const accountant = { userId: 'a', permissions: perms('expenses.advance.issue') };
    const management = { userId: 'm', permissions: perms('expenses.claim.read_all') };
    const claimant = { userId: 'u1', permissions: perms('expenses.claim.read_own') };
    expect(canSeeAllCustodians(accountant)).toBe(true);
    expect(canSeeAllCustodians(management)).toBe(true);
    expect(canSeeAllCustodians(claimant)).toBe(false);
    expect(() => assertCanReadBalance(accountant, 'u1')).not.toThrow();
    expect(() => assertCanReadBalance(claimant, 'u1')).not.toThrow();
    expect(() => assertCanReadBalance(claimant, 'u2')).toThrow(code('custodian_not_found'));
  });

  it('issues advances only to a registered, active custodian', () => {
    expect(() => assertCustodianUsable({ active: true })).not.toThrow();
    expect(() => assertCustodianUsable(undefined)).toThrow(code('custodian_not_found'));
    expect(() => assertCustodianUsable({ active: false })).toThrow(code('custodian_inactive'));
  });
});

describe('receipts as files', () => {
  const claimantPerms = perms('expenses.claim.create', 'expenses.claim.read_own');
  const ask = (over: Partial<Parameters<typeof canAccessReceipt>[0]> = {}): boolean =>
    canAccessReceipt({
      userId: 'u1',
      permissions: claimantPerms,
      operation: 'read',
      claimantId: 'u1',
      ...over,
    });

  it('lets the claimant read, upload and remove on their own claim', () => {
    expect(ask()).toBe(true);
    expect(ask({ operation: 'upload' })).toBe(true);
    expect(ask({ operation: 'remove' })).toBe(true);
  });

  it('lets finance read but not change someone else’s receipts', () => {
    const finance = perms('expenses.claim.read_all');
    expect(ask({ userId: 'u9', permissions: finance })).toBe(true);
    expect(ask({ userId: 'u9', permissions: finance, operation: 'upload' })).toBe(false);
  });

  it('refuses another claimant, a claim that does not exist and a claimant without the permission', () => {
    expect(ask({ userId: 'u3' })).toBe(false);
    expect(ask({ claimantId: undefined })).toBe(false);
    expect(ask({ permissions: perms('expenses.claim.read_own'), operation: 'upload' })).toBe(false);
  });
});
