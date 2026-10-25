import type { QuotationPrintModel, QuotationStatus, Stage } from '@emporium/domain/quotations';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { EstimateSector } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db, QuotationPrintModel, QuotationStatus, Stage };

/** Who is acting; the files module needs roles, scopes and permissions to check the proof of acceptance. */
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

export interface StageDto {
  stageNo: number;
  name: string;
  basis: 'percent' | 'amount';
  percent: string;
  amount: string;
  conditionText: string | null;
}

export interface QuotationHeaderDto {
  id: string;
  number: string;
  /** The revision of the quotation: 1 for the first, 2 for the first revision, and so on (BR-7). */
  revision: number;
  /** The number as printed: the base number, with `/<revision>` after the first revision. */
  displayNumber: string;
  parentId: string | null;
  leadId: string | null;
  estimateId: string;
  partyId: string;
  title: string;
  sector: EstimateSector;
  locationId: string | null;
  validityDays: number;
  price: string;
  status: QuotationStatus;
  issuedAt: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  expiresOn: string | null;
  /** The concurrency counter (constitution 5.2). */
  version: number;
}

export interface MarginPanelDto {
  totalCost: string;
  marginAmount: string;
  marginPercent: string;
  floorPercent: string;
  belowFloor: boolean;
}

export interface HistoryDto {
  fromStatus: QuotationStatus | null;
  toStatus: QuotationStatus;
  at: string;
  changedBy: string | null;
  note: string | null;
}

export interface QuotationDto extends QuotationHeaderDto {
  scopeText: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  stages: StageDto[];
  history: HistoryDto[];
  /** Only for callers who hold `quotations.margin.read`; otherwise null (spec section 5). */
  margin: MarginPanelDto | null;
  approval: { status: string; requestId: string | null; currentRole: string | null };
}
