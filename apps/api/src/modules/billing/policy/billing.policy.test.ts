import { describe, expect, it } from 'vitest';
import {
  assertAdvanceInvoiceIssued,
  assertAdvanceRequested,
  assertAdvanceUnused,
  assertApproved,
  assertDraftCredit,
  assertFiguresUnchanged,
  assertFound,
  assertIssuedInvoice,
  assertNoPendingScheduleEdit,
  assertPositive,
  assertProjectBillable,
  assertProjectHasLocation,
  assertProjectReachable,
  assertSingleSupplyKind,
  assertSourceFree,
  assertSourceKnown,
  assertStagesAvailable,
  assertSubmittable,
  assertUpdated,
} from './billing.policy.js';

const ID = '018f7c7c-0000-7000-8000-000000000001';

describe('billing policy', () => {
  it('reports a missing record as not found and a missed update as a version conflict', () => {
    expect(assertFound({ a: 1 }, 'invoice')).toEqual({ a: 1 });
    expect(() => assertFound(undefined, 'invoice')).toThrow('Not found');
    expect(assertUpdated({ a: 1 })).toEqual({ a: 1 });
    expect(() => assertUpdated(undefined)).toThrow('changed by someone else');
  });

  it('lets a scope-limited user reach only their own projects', () => {
    const scoped = { roles: ['supervisor'], scopes: [{ type: 'project' as const, id: ID }] };
    expect(() => assertProjectReachable(scoped, ID)).not.toThrow();
    expect(() => assertProjectReachable(scoped, 'other')).toThrow('Not found');
    expect(() =>
      assertProjectReachable({ roles: ['accountant'], scopes: [] }, 'other'),
    ).not.toThrow();
  });

  it('bills every project except a cancelled or closed one', () => {
    for (const status of ['planning', 'active', 'on_hold', 'completed']) {
      expect(() => assertProjectBillable(status)).not.toThrow();
    }
    expect(() => assertProjectBillable('cancelled')).toThrow('cancelled project cannot be billed');
    expect(() => assertProjectBillable('closed')).toThrow('closed project cannot be billed');
  });

  it('needs a project location to resolve the tax authority', () => {
    expect(assertProjectHasLocation(ID)).toBe(ID);
    expect(() => assertProjectHasLocation(null)).toThrow('tax authority cannot be resolved');
  });

  it('blocks while a schedule edit is waiting', () => {
    expect(() => assertNoPendingScheduleEdit(null)).not.toThrow();
    expect(() => assertNoPendingScheduleEdit(ID)).toThrow('waiting for approval');
  });

  it('checks the stages of an invoice', () => {
    const planned = [{ id: 'a', status: 'planned' }];
    const ok = { requested: ['a'], found: planned, taken: [] };
    expect(() => assertStagesAvailable(ok)).not.toThrow();
    expect(() => assertStagesAvailable({ ...ok, requested: [] })).toThrow('at least one stage');
    expect(() => assertStagesAvailable({ ...ok, requested: ['a', 'a'] })).toThrow('listed twice');
    expect(() => assertStagesAvailable({ ...ok, requested: ['a', 'b'] })).toThrow('not found');
    expect(() =>
      assertStagesAvailable({ ...ok, found: [{ id: 'a', status: 'invoiced' }] }),
    ).toThrow('already invoiced');
    expect(() => assertStagesAvailable({ ...ok, taken: ['a'] })).toThrow('already invoiced');
  });

  it('allows one supply kind per invoice', () => {
    expect(assertSingleSupplyKind(['services', 'services'])).toBe('services');
    expect(() => assertSingleSupplyKind(['services', 'goods'])).toThrow(
      'goods or services, not both',
    );
    expect(() => assertSingleSupplyKind([])).toThrow('goods or services, not both');
  });

  it('names the figures that changed since approval (BR-6)', () => {
    expect(() => assertFiguresUnchanged({ a: '1', b: '2' }, { a: '1', b: '2' })).not.toThrow();
    expect(() => assertFiguresUnchanged({ a: '1', b: '2' }, { a: '1', b: '3' })).toThrow(
      'figures changed since approval (b)',
    );
  });

  it('credits only issued invoices, approved and draft credit notes', () => {
    expect(() => assertIssuedInvoice('issued')).not.toThrow();
    expect(() => assertIssuedInvoice('draft')).toThrow('Only an issued invoice');
    expect(() => assertApproved('approved')).not.toThrow();
    expect(() => assertApproved('pending')).toThrow('not approved yet');
    expect(() => assertDraftCredit('draft')).not.toThrow();
    expect(() => assertDraftCredit('issued')).toThrow('already issued');
    for (const status of ['none', 'rejected', 'returned', 'cancelled']) {
      expect(() => assertSubmittable(status)).not.toThrow();
    }
    for (const status of ['pending', 'approved']) {
      expect(() => assertSubmittable(status)).toThrow('already submitted');
    }
  });

  it('guards the advance (BR-8)', () => {
    expect(() => assertAdvanceUnused('0.00')).not.toThrow();
    expect(() => assertAdvanceUnused('0.01')).toThrow('already applied to invoices');
    expect(() => assertAdvanceRequested('requested')).not.toThrow();
    expect(() => assertAdvanceRequested('received')).toThrow('already received');
    expect(() => assertAdvanceInvoiceIssued('issued')).not.toThrow();
    expect(() => assertAdvanceInvoiceIssued('draft')).toThrow('must be issued');
    expect(() => assertAdvanceInvoiceIssued(null)).toThrow('must be issued');
    expect(() => assertPositive('0.01', 'amount')).not.toThrow();
    expect(() => assertPositive('0', 'amount')).toThrow('amount must be above zero');
    expect(() => assertPositive('-5', 'amount')).toThrow('amount must be above zero');
  });

  it('registers one provider per invoice source (BR-12)', () => {
    expect(() => assertSourceFree(false, 'x')).not.toThrow();
    expect(() => assertSourceFree(true, 'x')).toThrow('already registered');
    expect(assertSourceKnown('provider', 'x')).toBe('provider');
    expect(() => assertSourceKnown(undefined, 'x')).toThrow('Unknown invoice source x');
  });
});
