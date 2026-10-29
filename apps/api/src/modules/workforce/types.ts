import type { ScopeGrant } from '@emporium/domain/identity';
import type { EmploymentType, PayBasis, WorkerStatus } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; supervisors are limited to the teams in their scopes. */
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

export interface TradeDto {
  code: string;
  name: string;
  version: number;
}

/**
 * A worker as people see them. There is no pay information in it, whoever asks (BR-7): rates have
 * their own DTO behind `workforce.rate.read`.
 */
export interface WorkerDto {
  id: string;
  code: string;
  fullName: string;
  fatherName: string | null;
  /** Masked to the last 4 digits in lists and for anyone without `workforce.worker.manage` (BR-8). */
  cnic: string | null;
  phone: string | null;
  tradeCode: string;
  employmentType: EmploymentType;
  contractorPartyId: string | null;
  joinedOn: string;
  leftOn: string | null;
  status: WorkerStatus;
  /** Masked like the CNIC. */
  bankOrWalletInfo: string | null;
  version: number;
}

export interface RateDto {
  id: string;
  workerId: string;
  payBasis: PayBasis;
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  setBy: string | null;
}

/** What `getWorkerRate` returns to other modules (spec section 2). */
export interface WorkerRateDto {
  workerId: string;
  date: string;
  payBasis: PayBasis;
  amount: string;
  dailyEquivalent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TeamDto {
  id: string;
  code: string;
  name: string;
  supervisorUserId: string;
  active: boolean;
  version: number;
}

export interface TeamMemberDto {
  teamId: string;
  workerId: string;
  code: string;
  fullName: string;
  tradeCode: string;
  fromDate: string;
  toDate: string | null;
}

export interface TeamDetailDto extends TeamDto {
  members: TeamMemberDto[];
}
