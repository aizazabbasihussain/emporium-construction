import type { ScopeGrant } from '@emporium/domain/identity';
import type { BudgetFlag } from '@emporium/domain/costing';
import type {
  BudgetSource,
  CostObjectType,
  CostStatus,
  ProjectSector,
  ProjectStatus,
  TaskStatus,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; supervisors are limited to the projects in their scopes. */
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

export interface ProjectDto {
  id: string;
  code: string;
  name: string;
  partyId: string;
  sector: ProjectSector;
  locationId: string | null;
  siteAddress: string | null;
  status: ProjectStatus;
  startDate: string | null;
  plannedEndDate: string | null;
  actualEndDate: string | null;
  /** Fixed at creation (BR-1); later changes arrive as variations. */
  originalContractValue: string;
  quotationId: string | null;
  estimateId: string | null;
  projectManagerId: string | null;
  /** The average of the task percents (BR-10), to two decimals. */
  progressPercent: string;
  version: number;
}

export interface SupervisorDto {
  userId: string;
  fromDate: string;
  toDate: string | null;
}

export interface ProjectDetailDto extends ProjectDto {
  supervisors: SupervisorDto[];
}

export interface BudgetLineDto {
  id: string;
  costCodeId: string;
  description: string;
  budgetAmount: string;
  source: BudgetSource;
}

export interface BudgetDto {
  projectVersion: number;
  lines: BudgetLineDto[];
}

export interface TaskDto {
  id: string;
  projectId: string;
  name: string;
  assignedToUser: string | null;
  startDate: string | null;
  dueDate: string | null;
  status: TaskStatus;
  percentComplete: number;
  version: number;
}

export interface CostEntryDto {
  id: string;
  costObjectType: CostObjectType;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  status: CostStatus;
  sourceModule: string;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId: string | null;
  entryDate: string;
  description: string;
  idempotencyKey: string;
  reversesEntryId: string | null;
  createdAt: string;
}

/** Budget fields are set for a project and null for overhead and work orders (BR-8). */
export interface CostSummaryLineDto {
  costCodeId: string;
  committed: string;
  approved: string;
  posted: string;
  budget: string | null;
  variance: string | null;
  flag: BudgetFlag | null;
}

export interface CostSummaryDto {
  costObjectType: CostObjectType;
  costObjectId: string | null;
  lines: CostSummaryLineDto[];
  totals: { committed: string; approved: string; posted: string };
  budget: string | null;
  variance: string | null;
  flag: BudgetFlag | null;
}

export interface CostObjectRef {
  type: CostObjectType;
  id: string | null;
}
