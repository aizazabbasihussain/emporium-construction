import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertBillable,
  assertCanCancel,
  assertCanClose,
  assertChargeEditable,
  assertCloseReason,
  assertCostCodeActive,
  assertDraft,
  assertFound,
  assertLinkable,
  assertNoOpenCertificate,
  assertNotOwnVariation,
  assertOrderActive,
  assertProjectActive,
  assertProjectReachable,
  assertRecoveryCode,
  assertSubcontractor,
  assertUpdated,
  canSeeAmounts,
} from './subcontracts.policy.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'none';
};

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('subcontracts policy (T-4, BR-1 to BR-9)', () => {
  it('reports missing rows as not found and a moved version as a conflict', () => {
    expect(assertFound('row', 'work_order')).toBe('row');
    expect(codeOf(() => assertFound(undefined, 'work_order'))).toBe('work_order_not_found');
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(() => assertApplied(true)).not.toThrow();
    expect(codeOf(() => assertApplied(false))).toBe('version_conflict');
  });

  it('limits a supervisor to the projects assigned to them', () => {
    const supervisor = { roles: ['supervisor'], scopes: [{ type: 'project' as const, id: 'p1' }] };
    expect(() => assertProjectReachable(supervisor, 'p1')).not.toThrow();
    expect(codeOf(() => assertProjectReachable(supervisor, 'p2'))).toBe('project_not_found');
    expect(() =>
      assertProjectReachable({ roles: ['project_manager'], scopes: [] }, 'p2'),
    ).not.toThrow();
  });

  it('hides amounts from those without the amount permission (BR-9)', () => {
    expect(canSeeAmounts(new Set(['subcontracts.amount.read']))).toBe(true);
    expect(canSeeAmounts(new Set(['subcontracts.order.read']))).toBe(false);
  });

  it('needs an active project, an active subcontractor or labour contractor and an active code (BR-1)', () => {
    expect(() => assertProjectActive('active')).not.toThrow();
    expect(codeOf(() => assertProjectActive('on_hold'))).toBe('project_not_active');
    expect(() => assertSubcontractor({ roles: ['subcontractor'], status: 'active' })).not.toThrow();
    expect(() =>
      assertSubcontractor({ roles: ['labour_contractor'], status: 'active' }),
    ).not.toThrow();
    expect(codeOf(() => assertSubcontractor(undefined))).toBe('party_not_found');
    expect(codeOf(() => assertSubcontractor({ roles: ['vendor'], status: 'active' }))).toBe(
      'not_a_subcontractor',
    );
    expect(
      codeOf(() => assertSubcontractor({ roles: ['subcontractor'], status: 'inactive' })),
    ).toBe('party_inactive');
    expect(() => assertCostCodeActive(true)).not.toThrow();
    expect(codeOf(() => assertCostCodeActive(false))).toBe('cost_code_inactive');
  });

  it('allows edits only to drafts and variations or certificates only on an active order', () => {
    expect(() => assertDraft('draft', 'work_order')).not.toThrow();
    expect(codeOf(() => assertDraft('active', 'work_order'))).toBe('work_order_not_editable');
    expect(() => assertOrderActive('active')).not.toThrow();
    expect(codeOf(() => assertOrderActive('completed'))).toBe('order_not_active');
  });

  it('allows one open certificate at a time (BR-2)', () => {
    expect(() => assertNoOpenCertificate(counts({ certified: 2 }))).not.toThrow();
    expect(codeOf(() => assertNoOpenCertificate(counts({ draft: 1 })))).toBe('open_certificate');
    expect(codeOf(() => assertNoOpenCertificate(counts({ pending_approval: 1 })))).toBe(
      'open_certificate',
    );
  });

  it('closes only an active or completed order without open certificates (BR-6)', () => {
    expect(() => assertCanClose('active', counts({}))).not.toThrow();
    expect(() => assertCanClose('completed', counts({ certified: 1 }))).not.toThrow();
    expect(codeOf(() => assertCanClose('draft', counts({})))).toBe('order_not_closable');
    expect(codeOf(() => assertCanClose('active', counts({ draft: 1 })))).toBe('open_certificate');
    expect(() => assertCloseReason(false, null)).not.toThrow();
    expect(() => assertCloseReason(true, 'Left the site')).not.toThrow();
    expect(codeOf(() => assertCloseReason(true, null))).toBe('close_reason_required');
  });

  it('cancels only an order with nothing certified (BR-7)', () => {
    expect(() => assertCanCancel(counts({}))).not.toThrow();
    expect(() => assertCanCancel(counts({ cancelled: 3 }))).not.toThrow();
    expect(codeOf(() => assertCanCancel(counts({ certified: 1 })))).toBe('order_has_certified');
    expect(codeOf(() => assertCanCancel(counts({ billed: 1 })))).toBe('order_has_certified');
    expect(codeOf(() => assertCanCancel(counts({ draft: 1 })))).toBe('open_certificate');
  });

  it('keeps the proposer of a variation from approving it', () => {
    expect(() => assertNotOwnVariation('a', 'b')).not.toThrow();
    expect(() => assertNotOwnVariation('a', null)).not.toThrow();
    expect(codeOf(() => assertNotOwnVariation('a', 'a'))).toBe('own_variation');
  });

  it('checks back-charges (BR-3, BR-4)', () => {
    expect(() => assertRecoveryCode(false, undefined)).not.toThrow();
    expect(() => assertRecoveryCode(true, 'code')).not.toThrow();
    expect(codeOf(() => assertRecoveryCode(true, undefined))).toBe('cost_code_required');
    expect(() => assertLinkable({ work_order_id: 'w', status: 'draft' }, 'w')).not.toThrow();
    expect(codeOf(() => assertLinkable(undefined, 'w'))).toBe('certificate_not_found');
    expect(codeOf(() => assertLinkable({ work_order_id: 'other', status: 'draft' }, 'w'))).toBe(
      'certificate_not_found',
    );
    expect(codeOf(() => assertLinkable({ work_order_id: 'w', status: 'certified' }, 'w'))).toBe(
      'certificate_not_editable',
    );
    expect(() => assertChargeEditable(null)).not.toThrow();
    expect(() => assertChargeEditable('draft')).not.toThrow();
    expect(codeOf(() => assertChargeEditable('certified'))).toBe('certificate_not_editable');
  });

  it('bills only a certified certificate without a live bill (BR-5)', () => {
    expect(() => assertBillable('certified', false)).not.toThrow();
    expect(codeOf(() => assertBillable('draft', false))).toBe('certificate_not_certified');
    expect(codeOf(() => assertBillable('certified', true))).toBe('already_billed');
  });
});
