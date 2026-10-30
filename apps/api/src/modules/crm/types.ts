import type { FollowUpStatus, LeadSector, LeadWorkType, StageKind } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

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

export interface StageDto {
  code: string;
  name: string;
  sortOrder: number;
  kind: StageKind;
  active: boolean;
}

export interface ReferenceDto {
  code: string;
  name: string;
}

export interface LeadDto {
  id: string;
  number: string;
  partyId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  workType: LeadWorkType;
  sector: LeadSector;
  locationId: string | null;
  siteAddress: string | null;
  description: string | null;
  expectedValue: string | null;
  sourceCode: string;
  stageCode: string;
  stageKind: StageKind;
  ownerUserId: string;
  lossReasonCode: string | null;
  wonAt: string | null;
  lostAt: string | null;
  /** BR-5: the lead has an open follow-up whose due date has passed. */
  hasOverdueFollowUp: boolean;
  version: number;
}

export interface VisitDto {
  id: string;
  leadId: string;
  visitDate: string;
  visitedBy: string;
  notes: string | null;
  version: number;
}

export interface FollowUpDto {
  id: string;
  leadId: string;
  leadNumber: string;
  dueDate: string;
  note: string | null;
  assignedTo: string;
  status: FollowUpStatus;
  doneAt: string | null;
  /** BR-5 */
  overdue: boolean;
  version: number;
}

export interface StageHistoryDto {
  fromStage: string | null;
  toStage: string;
  at: string;
  by: string | null;
}

export interface LeadDetailDto {
  lead: LeadDto;
  visits: VisitDto[];
  followUps: FollowUpDto[];
  history: StageHistoryDto[];
}

/** P1-19 BR-6: leads won and lost in a period, and the conversion rate won / (won + lost). */
export interface ConversionDto {
  from: string;
  to: string;
  won: number;
  lost: number;
  /** A percentage with two decimals; null when nothing was won or lost. */
  rate: string | null;
  months: { month: string; won: number; lost: number; rate: string | null }[];
}

export interface PipelineDto {
  stages: {
    stageCode: string;
    name: string;
    kind: StageKind;
    count: number;
    expectedValue: string;
  }[];
  totalCount: number;
  totalExpectedValue: string;
  overdueFollowUps: number;
}
