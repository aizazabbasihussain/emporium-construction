import { currentContractAmount } from '@emporium/domain/subcontracts';
import type { ApprovalState } from '../../approvals/index.js';
import {
  certifiedCumulative,
  listVariations,
  type BackChargeRow,
  type CertificateRow,
  type VariationRow,
  type WorkOrderRow,
} from '../repo/subcontracts.repo.js';
import type {
  Amount,
  ApprovalDto,
  BackChargeDto,
  CertificateDto,
  CertificateStatus,
  Db,
  VariationStatus,
  WorkOrderHeaderDto,
  WorkOrderStatus,
  WorkOrderVariationDto,
} from '../types.js';

/** BR-9: an amount is shown only to someone who may read amounts. */
export const shown = (visible: boolean, value: string): Amount => (visible ? value : null);

export interface OrderFigures {
  /** The contract including approved variations. */
  current: string;
  /** The cumulative gross of the certified certificates. */
  certified: string;
}

/** BR-2: the current contract and what is certified, read together. */
export async function figuresOf(db: Db, row: WorkOrderRow): Promise<OrderFigures> {
  const approved = (await listVariations(db, row.id))
    .filter((v) => v.status === 'approved')
    .map((v) => v.amount);
  return {
    current: currentContractAmount(row.contract_amount, approved),
    certified: await certifiedCumulative(db, row.id),
  };
}

export const headerOf = (
  row: WorkOrderRow,
  figures: OrderFigures,
  visible: boolean,
): WorkOrderHeaderDto => ({
  id: row.id,
  number: row.number,
  projectId: row.project_id,
  partyId: row.party_id,
  title: row.title,
  status: row.status as WorkOrderStatus,
  contractAmount: shown(visible, row.contract_amount),
  currentContractAmount: shown(visible, figures.current),
  certifiedAmount: shown(visible, figures.certified),
  committedAmount: shown(visible, row.commitment_amount),
  startDate: row.start_date,
  endDate: row.end_date,
  version: row.version,
});

export const variationDtoOf = (row: VariationRow, visible: boolean): WorkOrderVariationDto => ({
  id: row.id,
  seq: row.seq,
  amount: shown(visible, row.amount),
  reason: row.reason,
  status: row.status as VariationStatus,
  decidedOn: row.decided_on,
  decisionNote: row.decision_note,
  version: row.version,
});

export const chargeDtoOf = (row: BackChargeRow, visible: boolean): BackChargeDto => ({
  id: row.id,
  workOrderId: row.work_order_id,
  certificateId: row.certificate_id,
  description: row.description,
  amount: shown(visible, row.amount),
  recoversCost: row.recovers_cost,
  costCodeId: row.cost_code_id,
  version: row.version,
});

export const approvalOf = (state: ApprovalState): ApprovalDto =>
  state.status === 'none'
    ? { status: 'none', requestId: null, currentRole: null }
    : { status: state.status, requestId: state.id, currentRole: state.currentRole };

export const certificateDtoOf = (
  row: CertificateRow,
  charges: readonly BackChargeRow[],
  approval: ApprovalState,
  visible: boolean,
): CertificateDto => ({
  id: row.id,
  number: row.number,
  workOrderId: row.work_order_id,
  certificateDate: row.certificate_date,
  basis: row.basis as CertificateDto['basis'],
  cumulativePercent: row.cumulative_percent,
  cumulativeAmount: shown(visible, row.cumulative_amount),
  thisCertificateAmount: shown(visible, row.this_certificate_amount),
  deductions: shown(visible, row.deductions),
  netCertified: shown(visible, row.net_certified),
  status: row.status as CertificateStatus,
  certifiedBy: row.certified_by,
  certifiedOn: row.certified_on,
  notes: row.notes,
  billId: row.bill_id,
  backCharges: charges.map((charge) => chargeDtoOf(charge, visible)),
  approval: approvalOf(approval),
  version: row.version,
});
