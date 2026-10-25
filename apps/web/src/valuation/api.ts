import type { PolicyScope, PolicyStatus, ValuationMethod } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Policy {
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

export interface PolicyRequest {
  scope: PolicyScope;
  categoryId?: string | undefined;
  method: ValuationMethod;
  effectiveFrom: string;
}

export interface StockValue {
  storeId: string;
  itemId: string;
  categoryId: string | null;
  method: ValuationMethod;
  quantity: string;
  value: string;
  averageCost: string;
}

export interface StockValueReport {
  items: StockValue[];
  totalValue: string;
}

export interface Transition {
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

export const valuationApi = {
  policies: () => request<{ items: Policy[] }>('GET', '/valuation/policies'),
  requestPolicy: (body: PolicyRequest) => request<Policy>('POST', '/valuation/policies', body),
  stockValue: (category?: string) =>
    request<StockValueReport>(
      'GET',
      category === undefined
        ? '/valuation/stock-value'
        : `/valuation/stock-value?category=${encodeURIComponent(category)}`,
    ),
  transitions: (offset: number, limit: number) =>
    request<Page<Transition>>('GET', `/valuation/transitions?limit=${limit}&offset=${offset}`),
  runTransitions: () => request<{ items: Transition[] }>('POST', '/valuation/transitions/run'),
};
