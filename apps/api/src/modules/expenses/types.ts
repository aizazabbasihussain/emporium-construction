import type { ClaimStatus, Duplicate } from '@emporium/domain/expenses';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { AdvanceStatus, ClaimCostObjectType } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { AdvanceStatus, ClaimStatus, Db, Duplicate };

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

export interface ClaimLineDto {
  id: string;
  lineNo: number;
  expenseDate: string;
  category: string;
  description: string;
  costObjectType: ClaimCostObjectType;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  receiptFileId: string | null;
}

export interface ClaimHeaderDto {
  id: string;
  number: string;
  claimantId: string;
  submittedOn: string | null;
  status: ClaimStatus;
  total: string;
  note: string;
  cancelReason: string | null;
  version: number;
}

export interface ClaimDto extends ClaimHeaderDto {
  lines: ClaimLineDto[];
  /** BR-9: lines that look like repeats; present while the claim can still be submitted. */
  duplicates: Duplicate[];
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

export interface AdvanceDto {
  id: string;
  number: string;
  custodianId: string;
  amount: string;
  issuedOn: string;
  issuedBy: string;
  purpose: string;
  status: AdvanceStatus;
  settledOn: string | null;
  settlementNote: string | null;
  version: number;
}

export interface CustodianDto {
  userId: string;
  floatLimit: string;
  active: boolean;
  /** BR-1: advances issued minus approved and posted claims; negative means the company owes. */
  balance: string;
  version: number;
}

/** A person an advance can be given to. */
export interface CandidateDto {
  id: string;
  fullName: string;
  email: string;
}

export interface CategoryDto {
  code: string;
  name: string;
  defaultCostCodeId: string | null;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
  version: number;
}
