import { RuleViolationError } from '../errors.js';

export type WorkOrderStatus =
  'draft' | 'pending_approval' | 'active' | 'completed' | 'closed' | 'cancelled';

export type CertificateStatus = 'draft' | 'pending_approval' | 'certified' | 'billed' | 'cancelled';

export type VariationStatus = 'draft' | 'approved' | 'rejected';

/**
 * Constitution 5.8: the allowed work order transitions. An order whose approval is refused goes back
 * to draft; it becomes `completed` when the whole contract is certified (BR-6) and `closed` when the
 * remainder is released; only an order with nothing certified can be cancelled (BR-7).
 */
export const workOrderTransitions: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['active', 'draft'],
  active: ['completed', 'closed', 'cancelled'],
  completed: ['closed'],
  closed: [],
  cancelled: [],
};

/** A certificate is billed when its bill is posted and certified again if that bill is cancelled. */
export const certificateTransitions: Record<CertificateStatus, readonly CertificateStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['certified', 'draft', 'cancelled'],
  certified: ['billed'],
  billed: ['certified'],
  cancelled: [],
};

export const variationTransitions: Record<VariationStatus, readonly VariationStatus[]> = {
  draft: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function assertWorkOrderTransition(from: WorkOrderStatus, to: WorkOrderStatus): void {
  if (!workOrderTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'work_order_transition',
      `A ${from} work order cannot become ${to}`,
    );
  }
}

export function assertCertificateTransition(from: CertificateStatus, to: CertificateStatus): void {
  if (!certificateTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'certificate_transition',
      `A ${from} certificate cannot become ${to}`,
    );
  }
}

export function assertVariationTransition(from: VariationStatus, to: VariationStatus): void {
  if (!variationTransitions[from].includes(to)) {
    throw new RuleViolationError('variation_transition', `A ${from} variation cannot become ${to}`);
  }
}

/** Only a draft work order, certificate or variation can be edited. */
export const isEditable = (status: string): boolean => status === 'draft';

/** BR-7: a certificate that counts as certified work (certified or already billed). */
export const isCertifiedStatus = (status: CertificateStatus): boolean =>
  status === 'certified' || status === 'billed';

/** BR-6: certificates that are still open work and block closing or cancelling. */
export const isOpenCertificate = (status: CertificateStatus): boolean =>
  status === 'draft' || status === 'pending_approval';
