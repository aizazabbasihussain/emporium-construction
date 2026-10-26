import type { AtRisk, VariationStatus } from '@emporium/domain/variations';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { Db } from '../platform/index.js';

export type { AtRisk, Db, VariationStatus };

/** Who is acting; a supervisor reaches only the projects assigned to them. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface VariationHeaderDto {
  id: string;
  projectId: string;
  number: string;
  title: string;
  reason: string;
  discoveredOn: string;
  status: VariationStatus;
  priceImpact: string;
  costImpact: string;
  clientApprovalRef: string | null;
  clientApprovedOn: string | null;
  copiedFromId: string | null;
  /** BR-8: the total of costs at risk while the variation is not yet approved. */
  atRiskTotal: string;
  version: number;
}

export interface VariationLineDto {
  lineNo: number;
  description: string;
  costCodeId: string;
  costAmount: string;
  priceAmount: string;
}

export interface HistoryDto {
  fromStatus: VariationStatus | null;
  toStatus: VariationStatus;
  at: string;
  changedBy: string | null;
  note: string | null;
}

export interface VariationDto extends VariationHeaderDto {
  lines: VariationLineDto[];
  history: HistoryDto[];
  atRisk: AtRisk;
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

/** `GET /projects/:id/contract-value` (BR-5). */
export interface ContractValueDto {
  projectId: string;
  originalContractValue: string;
  approvedPriceImpact: string;
  currentContractValue: string;
  approvedVariations: number;
}
