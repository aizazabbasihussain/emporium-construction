import type { ScopeGrant } from '@emporium/domain/identity';
import type { ApprovalAction, ApprovalStatus } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; `roles` and `scopes` come from the authenticated user. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  requestId: string | null;
}

/** What a module passes when it asks for approval of one of its documents. */
export interface RequestApprovalInput {
  docType: string;
  docId: string;
  amount: string;
  requesterId: string;
  /** Owning-module data shown to approvers; `scope: { type, id }` limits who may act (BR-7). */
  context?: Record<string, unknown>;
  requestId?: string | null;
}

export interface StepDto {
  stepNo: number;
  roleCode: string;
  minApprovers: number;
}

export interface ActionDto {
  stepNo: number;
  actorId: string;
  action: ApprovalAction;
  comment: string | null;
  at: string;
}

export interface RequestDto {
  id: string;
  docType: string;
  docId: string;
  revision: number;
  amount: string;
  requesterId: string;
  status: ApprovalStatus;
  currentStep: number;
  currentRole: string | null;
  ruleId: string;
  context: Record<string, unknown>;
  submittedAt: string;
  decidedAt: string | null;
  version: number;
  steps: StepDto[];
  actions: ActionDto[];
}

/** The state a module reads for one document; `none` means it was never submitted. */
export type ApprovalState = RequestDto | { status: 'none'; docType: string; docId: string };

export interface RuleBandDto {
  minAmount: string;
  maxAmount: string | null;
  steps: StepDto[];
}

export interface RuleSetDto {
  effectiveFrom: string;
  bands: RuleBandDto[];
}

export interface RuleSetInput {
  effectiveFrom: string;
  bands: { minAmount: string; maxAmount: string | null; steps: StepDto[] }[];
}
