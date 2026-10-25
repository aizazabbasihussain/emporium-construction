import type { MovementType, PolicyScope, PolicyStatus, ValuationMethod } from '@emporium/shared';
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

export interface PolicyDto {
  id: string;
  scope: PolicyScope;
  categoryId: string | null;
  method: ValuationMethod;
  effectiveFrom: string;
  status: PolicyStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
}

/** One part of an issue: a FIFO layer, or the whole issue for weighted average (no layer). */
export interface PartDto {
  layerId: string | null;
  quantity: string;
  unitCost: string;
  value: string;
}

/** What a valuation call returns to inventory. A repeat of the same idempotency key returns the same result. */
export interface MovementResult {
  movementId: string;
  seq: number;
  type: MovementType;
  storeId: string;
  itemId: string;
  quantity: string;
  value: string;
  unitCost: string;
  method: ValuationMethod;
  parts: PartDto[];
}

export interface TransferResult {
  out: MovementResult;
  in: MovementResult;
}

export interface MovementDto extends MovementResult {
  postingDate: string;
  sourceRef: string | null;
  issueMovementId: string | null;
  createdAt: string;
}

export interface StockValueDto {
  storeId: string;
  itemId: string;
  categoryId: string | null;
  method: ValuationMethod;
  quantity: string;
  value: string;
  averageCost: string;
}

export interface StockValueReport {
  items: StockValueDto[];
  totalValue: string;
}

export interface TransitionDto {
  id: string;
  storeId: string;
  itemId: string;
  fromMethod: ValuationMethod;
  toMethod: ValuationMethod;
  quantity: string;
  valueBefore: string;
  valueAfter: string;
  policyId: string;
  completedAt: string;
}
