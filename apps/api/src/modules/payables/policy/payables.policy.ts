import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { Money } from '@emporium/domain/kernel';
import {
  assertBillTransition,
  assertPaymentTransition,
  type BillStatus,
  type PaymentStatus,
} from '@emporium/domain/payables';

export { assertBillTransition, assertPaymentTransition };

export function assertFound<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return value;
}

/** Optimistic concurrency (constitution 5.2): a missed update means the version moved on. */
export function assertUpdated<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return value;
}

/** The caller worked from an old copy of the record (constitution 5.2). */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

export function assertPositive(amount: string, field: string): void {
  const value = Money.of(amount);
  if (value.isNegative() || value.isZero()) {
    throw new ValidationError(`${field}_invalid`, `The ${field} must be above zero`);
  }
}

/** BR-10 of procurement and BR-2: only an active vendor or subcontractor is billed against. */
export function assertVendor(party: { roles: string[]; status: string } | undefined): void {
  if (party === undefined) throw new NotFoundError('vendor_not_found', 'The vendor does not exist');
  if (!party.roles.some((role) => role === 'vendor' || role === 'subcontractor')) {
    throw new RuleViolationError('not_a_vendor', 'The party is not a vendor or subcontractor');
  }
  if (party.status !== 'active') {
    throw new RuleViolationError('vendor_inactive', 'The vendor is not active');
  }
}

/** BR-2: a vendor invoice number is recorded once. */
export function assertNotDuplicate(existing: unknown): void {
  if (existing !== undefined) {
    throw new ConflictError(
      'duplicate_bill',
      'A bill with this vendor invoice number is already recorded',
    );
  }
}

export function assertDueDate(billDate: string, dueDate: string): void {
  if (dueDate < billDate) {
    throw new ValidationError('due_before_bill', 'The due date cannot precede the bill date');
  }
}

/** BR-7: the cash paid equals the allocations less the withholding deducted. */
export function assertAmountMatches(stated: string | undefined, derived: string): void {
  if (stated !== undefined && !Money.of(stated).equals(Money.of(derived))) {
    throw new RuleViolationError(
      'allocation_sum_mismatch',
      `The allocations less withholding come to ${Money.of(derived).toString()}`,
    );
  }
}

/** A bill is edited while it is a draft or matched; editing sends it back to draft. */
export function assertBillEditable(status: BillStatus): void {
  if (status !== 'draft' && status !== 'matched') {
    throw new RuleViolationError('bill_not_editable', `A ${status} bill cannot be edited`);
  }
}

export function assertBillDraft(status: BillStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('bill_not_draft', 'Only a draft bill is matched');
  }
}

/** The lines of a purchase bill each name the receipt line they bill. */
export function assertPurchaseLine(grnId: string | undefined, grnLineId: string | undefined): void {
  if (grnId === undefined || grnLineId === undefined) {
    throw new ValidationError('receipt_line_required', 'A purchase line names its receipt line');
  }
}

/** A line of another source names its cost object and cost code. */
export function assertCostTarget(input: {
  costObjectType?: string | undefined;
  costObjectId?: string | undefined;
  costCodeId?: string | undefined;
}): void {
  if (input.costCodeId === undefined || input.costObjectType === undefined) {
    throw new ValidationError('cost_object_required', 'Choose the cost object and the cost code');
  }
  if ((input.costObjectType === 'overhead') !== (input.costObjectId === undefined)) {
    throw new ValidationError(
      'cost_object_invalid',
      'A project line names the project; an overhead line names none',
    );
  }
}

/** The receipt line exists on a posted receipt and its order is the vendor's. */
export function assertReceiptLine(input: {
  line: unknown;
  grnStatus: string | undefined;
  orderVendorId: string | undefined;
  vendorPartyId: string;
}): void {
  if (input.line === undefined || input.grnStatus === undefined) {
    throw new NotFoundError('receipt_line_not_found', 'The receipt line does not exist');
  }
  if (input.grnStatus !== 'posted') {
    throw new RuleViolationError('receipt_cancelled', 'The receipt was cancelled');
  }
  if (input.orderVendorId !== input.vendorPartyId) {
    throw new RuleViolationError('vendor_mismatch', 'The receipt belongs to another vendor');
  }
}

/** BR-1: variances beyond tolerance need a user with the override permission and a reason. */
export function assertMatchAccepted(input: {
  allWithinTolerance: boolean;
  overrideReason: string | undefined;
  canOverride: boolean;
}): void {
  if (input.allWithinTolerance) return;
  if (input.overrideReason === undefined || input.overrideReason.trim() === '') {
    throw new RuleViolationError(
      'match_variance',
      'The bill differs from the order and receipt beyond the tolerance; an override with a reason is needed',
    );
  }
  if (!input.canOverride) {
    throw new RuleViolationError('override_not_allowed', 'You may not override the match');
  }
}

/** BR-4: the user who entered the bill submits it, so the engine keeps them from approving it. */
export function assertEnteredBy(createdBy: string | null, userId: string): void {
  if (createdBy !== userId) {
    throw new RuleViolationError(
      'only_creator_submits',
      'Only the user who entered the bill submits it for approval',
    );
  }
}

/** BR-4, BR-5: posting needs an approved bill. */
export function assertPostable(status: BillStatus): void {
  if (status !== 'approved') {
    throw new RuleViolationError('bill_not_approved', 'Only an approved bill can be posted');
  }
}

/** BR-3: tax is rated for the place of supply, from a project or from the bill's own location. */
export function assertBillLocation(locationId: string | null | undefined): string {
  if (locationId === null || locationId === undefined) {
    throw new RuleViolationError(
      'location_required',
      'Name the location of supply: the bill has no project with a location',
    );
  }
  return locationId;
}

/** BR-10: cancelling a posted bill takes a reason and no payments allocated to it. */
export function assertBillCancellable(input: {
  status: BillStatus;
  reason: string;
  paymentsAllocated: boolean;
  receiptShared: boolean;
}): void {
  if (input.reason.trim() === '') {
    throw new ValidationError('reason_required', 'A reason is required');
  }
  if (input.receiptShared) {
    throw new RuleViolationError(
      'receipt_shared',
      'Another posted bill relies on the receipt cost this bill confirmed; cancel that bill first',
    );
  }
  if (input.paymentsAllocated) {
    throw new RuleViolationError(
      'bill_has_payments',
      'Cancel or reallocate the payments of this bill first',
    );
  }
  assertBillTransition(input.status, 'cancelled');
}

/** BR-5, H-22: the overhead cost code for variances on goods in stock exists. */
export function assertVarianceCostCode(costCodeId: string | undefined): string {
  if (costCodeId === undefined) {
    throw new RuleViolationError(
      'variance_cost_code_missing',
      'Set the overhead cost code for price variances first',
    );
  }
  return costCodeId;
}

/** BR-7: cheques carry their number and date. */
export function assertChequeDetails(
  method: string,
  chequeNumber: string | undefined,
  chequeDate: string | undefined,
): void {
  if (method === 'cheque' && ((chequeNumber ?? '').trim() === '' || chequeDate === undefined)) {
    throw new ValidationError('cheque_details_required', 'Enter the cheque number and date');
  }
}

/** BR-7: only bills that are posted and owed can be paid. */
export function assertBillsPayable(statuses: ReadonlyMap<string, string | undefined>): void {
  for (const [id, status] of statuses) {
    if (status === undefined) {
      throw new NotFoundError('bill_not_found', `Bill ${id} was not found`);
    }
    if (status !== 'posted' && status !== 'partly_paid') {
      throw new RuleViolationError('bill_not_payable', `Bill ${id} is not open for payment`);
    }
  }
}

/** BR-7: allocations are made against one vendor's bills. */
export function assertSingleVendor(vendors: readonly string[], vendorPartyId: string): void {
  if (vendors.some((vendor) => vendor !== vendorPartyId)) {
    throw new RuleViolationError('vendor_mismatch', 'A payment pays the bills of one vendor');
  }
}

export function assertPaymentDraft(status: PaymentStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('payment_not_draft', 'Only a draft payment can be submitted');
  }
}

/** BR-7: only approved payments are paid; the user who approved did not enter it. */
export function assertPayable(input: {
  status: PaymentStatus;
  approvers: readonly string[];
  actorUserId: string;
}): void {
  if (input.status !== 'approved') {
    throw new RuleViolationError('payment_not_approved', 'Only an approved payment can be paid');
  }
  if (input.approvers.includes(input.actorUserId)) {
    throw new RuleViolationError(
      'approver_cannot_pay',
      'The user who approved the payment cannot pay it',
    );
  }
}

/** Cancelling a payment takes a reason; one on a reconciled bank statement stays. */
export function assertPaymentCancellable(input: {
  status: PaymentStatus;
  reason: string;
  reconciled: boolean;
}): void {
  if (input.reason.trim() === '') {
    throw new ValidationError('reason_required', 'A reason is required');
  }
  if (input.reconciled) {
    throw new RuleViolationError(
      'payment_reconciled',
      'The payment is on a reconciled bank statement; un-reconcile it first',
    );
  }
  assertPaymentTransition(input.status, 'cancelled');
}

/** BR-11: a run pays the approved bills of selected vendors and picks at least one. */
export function assertRunBills(count: number): void {
  if (count === 0) {
    throw new ValidationError('run_empty', 'Select at least one bill for the run');
  }
}

/** BR-6: a bill source is known. */
export function assertSourceRegistered(provider: unknown, type: string): void {
  if (provider === undefined) {
    throw new ValidationError('unknown_bill_source', `No bill source is registered for ${type}`);
  }
}

/** BR-12: opening balances carry no cost posting and are entered once per vendor invoice. */
export function assertOpeningAmount(amount: string): void {
  assertPositive(amount, 'amount');
}
