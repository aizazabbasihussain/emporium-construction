import type {
  EstimateLineKind,
  EstimateSector,
  EstimateSupplier,
  EstimateWorkType,
} from '@emporium/shared';
import type {
  EstimateStatus,
  EstimateTotals,
  TemplateParameter,
} from '@emporium/domain/estimation';
import type { Db } from '../platform/index.js';

export type { Db, EstimateTotals, TemplateParameter };

/** Who is acting. Permissions are checked at the route; services only need the identity. */
export interface Actor {
  userId: string;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface TemplateLineDto {
  lineNo: number;
  description: string;
  lineKind: EstimateLineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  qtyFormula: string;
  defaultRate: string | null;
  suppliedBy: EstimateSupplier;
}

export interface TemplateDto {
  id: string;
  code: string;
  name: string;
  workType: EstimateWorkType;
  parameters: TemplateParameter[];
  active: boolean;
  lines: TemplateLineDto[];
  version: number;
}

export interface TemplateSummaryDto {
  id: string;
  code: string;
  name: string;
  workType: EstimateWorkType;
  active: boolean;
  version: number;
}

export interface EstimateLineDto {
  lineNo: number;
  description: string;
  lineKind: EstimateLineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  quantity: string;
  rate: string;
  suppliedBy: EstimateSupplier;
  note: string | null;
  /** BR-4: quantity times rate, rounded half-up to 2 decimals. */
  lineTotal: string;
  /** BR-3: a company line with no rate; it blocks locking. */
  rateMissing: boolean;
}

export interface EstimateHeaderDto {
  id: string;
  number: string;
  /** The revision of the estimate: 1 for the first, 2 for the first revision, and so on (BR-8). */
  revision: number;
  leadId: string | null;
  partyId: string | null;
  templateId: string | null;
  title: string;
  workType: EstimateWorkType;
  sector: EstimateSector;
  status: EstimateStatus;
  parentEstimateId: string | null;
  parameterValues: Record<string, string>;
  overheadPercent: string;
  contingencyPercent: string;
  targetMarginPercent: string;
  proposedPrice: string | null;
  lockedAt: string | null;
  /** The concurrency counter (constitution 5.2). */
  version: number;
}

export interface EstimateDto extends EstimateHeaderDto {
  lines: EstimateLineDto[];
}

export interface EstimateSummaryDto {
  estimate: EstimateDto;
  totals: EstimateTotals;
  rateMissingCount: number;
}

/** The company's costs of a locked estimate, for the project budget (P1-09). */
export interface EstimateCostLineDto {
  lineNo: number;
  description: string;
  lineKind: EstimateLineKind;
  costCodeId: string;
  itemId: string | null;
  unitCode: string;
  quantity: string;
  rate: string;
  /** Negative for salvage credits. */
  amount: string;
}

export interface FormulaPreviewResult {
  formula: string;
  ok: boolean;
  quantity: string | null;
  errorCode: string | null;
}
