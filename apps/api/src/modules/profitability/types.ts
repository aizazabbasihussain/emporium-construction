import type { ScopeGrant } from '@emporium/domain/identity';
import type { AlertCode, Financials } from '@emporium/domain/profitability';
import type { ProfitabilityAlertCode, ThresholdScope } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { AlertCode, Db, Financials, ProfitabilityAlertCode, ThresholdScope };

/** Who is asking; the permissions decide what they may do, the project manager link what they see. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
  /** Shown in the header block of an export. */
  name?: string | undefined;
}

/** A project as the profitability screens need it, read through the projects interface. */
export interface ProjectRef {
  id: string;
  code: string;
  name: string;
  status: string;
  projectManagerId: string | null;
}

export interface ForecastDto {
  id: string;
  projectId: string;
  costToComplete: string;
  note: string;
  forecastDate: string;
  setBy: string;
}

export interface ThresholdDto {
  id: string;
  scope: ThresholdScope;
  projectId: string | null;
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
  active: boolean;
  version: number;
}

export interface AlertDto {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  alertCode: AlertCode;
  raisedAt: string;
  clearedAt: string | null;
}

/** `GET /profitability/projects/:id`: every figure of BR-1 to BR-3 and the alerts that hold now. */
export interface ProjectFinancialsDto extends Financials {
  projectId: string;
  code: string;
  name: string;
  status: string;
  asOf: string;
  forecast: ForecastDto | null;
  thresholds: ThresholdDto | null;
  /** The alert conditions that are true on `asOf` (not the stored state). */
  alerts: AlertCode[];
  /** The oldest due date among the invoices that still owe money. */
  oldestDueDate: string | null;
}

/** BR-5: one row of the portfolio table. */
export interface PortfolioRowDto {
  projectId: string;
  code: string;
  name: string;
  status: string;
  contractValue: string;
  billedPercent: string | null;
  collectedPercent: string | null;
  costPercentOfBudget: string | null;
  expectedMargin: string;
  expectedMarginPercent: string | null;
  cashPosition: string;
  alerts: AlertCode[];
}

export interface PortfolioDto {
  asOf: string;
  items: PortfolioRowDto[];
}

export interface ThresholdInput {
  scope: ThresholdScope;
  projectId?: string | undefined;
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
  active?: boolean | undefined;
}
