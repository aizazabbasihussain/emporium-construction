import { procurementPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertAcceptsReceipts,
  assertCostCodeActive,
  assertDestinationReachable,
  assertFound,
  assertGrnCancellable,
  assertInvited,
  assertItemActive,
  assertKnown,
  assertPoAmendable,
  assertPoCancellable,
  assertPoClosable,
  assertPoDraft,
  assertRequisitionDraft,
  assertRequisitionOrderable,
  assertRfqOpen,
  assertUpdated,
  assertVendor,
  canAccessGrnPhoto,
} from './procurement.policy.js';

const code = (c: string): unknown => expect.objectContaining({ code: c });
const supervisor = { roles: ['supervisor'], scopes: [{ type: 'project' as const, id: 'p1' }] };
const officer = { roles: ['procurement'], scopes: [] };

describe('procurement policy', () => {
  it('reports a missing record as not found and a moved-on version as a conflict', () => {
    expect(assertFound('row', 'grn')).toBe('row');
    expect(() => assertFound(undefined, 'grn')).toThrow(code('grn_not_found'));
    expect(assertUpdated('row')).toBe('row');
    expect(() => assertUpdated(undefined)).toThrow(code('version_conflict'));
    expect(() => assertKnown(true, 'x', 'x')).not.toThrow();
    expect(() => assertKnown(false, 'unknown_x', 'x')).toThrow(code('unknown_x'));
  });

  it('limits a supervisor to assigned projects and never to a store (BR-12)', () => {
    expect(() =>
      assertDestinationReachable(supervisor, { type: 'project', id: 'p1' }),
    ).not.toThrow();
    expect(() => assertDestinationReachable(supervisor, { type: 'project', id: 'p2' })).toThrow(
      code('destination_not_found'),
    );
    expect(() => assertDestinationReachable(supervisor, { type: 'store', id: 's' })).toThrow(
      code('destination_not_found'),
    );
    expect(() => assertDestinationReachable(officer, { type: 'project', id: 'p2' })).not.toThrow();
    expect(() => assertDestinationReachable(officer, { type: 'store', id: 's' })).not.toThrow();
  });

  it('allows only active vendors, items and cost codes (BR-10)', () => {
    expect(() => assertVendor({ roles: ['vendor', 'client'], status: 'active' })).not.toThrow();
    expect(() => assertVendor({ roles: ['client'], status: 'active' })).toThrow(
      code('not_a_vendor'),
    );
    expect(() => assertVendor({ roles: ['vendor'], status: 'inactive' })).toThrow(
      code('not_a_vendor'),
    );
    expect(() => assertItemActive(true)).not.toThrow();
    expect(() => assertItemActive(false)).toThrow(code('item_inactive'));
    expect(() => assertCostCodeActive(true)).not.toThrow();
    expect(() => assertCostCodeActive(false)).toThrow(code('cost_code_inactive'));
  });

  it('guards the states of requisitions, quotations and orders', () => {
    expect(() => assertRequisitionDraft('draft')).not.toThrow();
    expect(() => assertRequisitionDraft('approved')).toThrow(code('requisition_read_only'));
    for (const status of ['approved', 'partly_ordered'] as const) {
      expect(() => assertRequisitionOrderable(status)).not.toThrow();
    }
    expect(() => assertRequisitionOrderable('draft')).toThrow(code('requisition_not_approved'));
    expect(() => assertRfqOpen('open')).not.toThrow();
    expect(() => assertRfqOpen('closed')).toThrow(code('rfq_closed'));
    expect(() => assertInvited(['v1'], 'v1')).not.toThrow();
    expect(() => assertInvited(['v1'], 'v2')).toThrow(code('vendor_not_invited'));
    expect(() => assertPoDraft('draft')).not.toThrow();
    expect(() => assertPoDraft('approved')).toThrow(code('po_read_only'));
  });

  it('amends and closes only orders that were approved (BR-5, BR-9)', () => {
    for (const status of ['approved', 'partly_received', 'received'] as const) {
      expect(() => assertPoAmendable(status)).not.toThrow();
      expect(() => assertPoClosable(status)).not.toThrow();
    }
    for (const status of ['draft', 'pending_approval', 'closed', 'cancelled'] as const) {
      expect(() => assertPoAmendable(status)).toThrow(code('po_not_amendable'));
      expect(() => assertPoClosable(status)).toThrow(code('po_not_closable'));
    }
    expect(() => assertPoCancellable(false)).not.toThrow();
    expect(() => assertPoCancellable(true)).toThrow(code('po_has_receipts'));
  });

  it('refuses to cancel a receipt that was issued or billed (BR-8)', () => {
    expect(() => assertGrnCancellable({ issued: false, billed: false })).not.toThrow();
    expect(() => assertGrnCancellable({ issued: true, billed: false })).toThrow(code('grn_issued'));
    expect(() => assertGrnCancellable({ issued: false, billed: true })).toThrow(code('grn_billed'));
    expect(() => assertAcceptsReceipts(true)).not.toThrow();
    expect(() => assertAcceptsReceipts(false)).toThrow(code('po_not_receivable'));
  });

  it('shows the challan photo to readers and lets receivers add it', () => {
    const read = new Set([procurementPermissions.grnRead]);
    const create = new Set([procurementPermissions.grnCreate]);
    expect(canAccessGrnPhoto({ permissions: read, operation: 'read', grnExists: true })).toBe(true);
    expect(canAccessGrnPhoto({ permissions: create, operation: 'read', grnExists: true })).toBe(
      false,
    );
    expect(canAccessGrnPhoto({ permissions: create, operation: 'upload', grnExists: true })).toBe(
      true,
    );
    expect(canAccessGrnPhoto({ permissions: read, operation: 'upload', grnExists: true })).toBe(
      false,
    );
    expect(canAccessGrnPhoto({ permissions: read, operation: 'read', grnExists: false })).toBe(
      false,
    );
  });
});
