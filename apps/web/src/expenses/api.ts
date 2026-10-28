import type { AdvanceStatus, ClaimCostObjectType, ClaimStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClaimHeader {
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

export interface ClaimLine {
  expenseDate: string;
  category: string;
  description: string;
  costObjectType: ClaimCostObjectType;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  receiptFileId: string | null;
}

export interface Duplicate {
  lineNo: number;
  matchedClaimNumber: string | null;
  matchedLineNo: number;
}

export interface Claim extends ClaimHeader {
  lines: (ClaimLine & { id: string; lineNo: number })[];
  duplicates: Duplicate[];
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

/** What the claim form sends; amounts stay text and the API checks them. */
export interface ClaimBody {
  note: string;
  lines: ClaimLine[];
}

export interface Advance {
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

export interface Custodian {
  userId: string;
  floatLimit: string;
  active: boolean;
  balance: string;
  version: number;
}

export interface Candidate {
  id: string;
  fullName: string;
  email: string;
}

export interface Category {
  code: string;
  name: string;
  defaultCostCodeId: string | null;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
  version: number;
}

export interface CategoryBody {
  code: string;
  name: string;
  defaultCostCodeId?: string | null;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
}

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
};

export const expensesApi = {
  claims: (params: { status?: ClaimStatus; mine?: boolean } = {}) =>
    request<Page<ClaimHeader>>(
      'GET',
      `/expenses/claims?${query({ status: params.status, mine: params.mine, limit: 200 })}`,
    ),
  claim: (id: string) => request<Claim>('GET', `/expenses/claims/${id}`),
  createClaim: (body: ClaimBody) => request<Claim>('POST', '/expenses/claims', body),
  updateClaim: (id: string, version: number, body: ClaimBody) =>
    request<Claim>('PUT', `/expenses/claims/${id}`, { ...body, version }),
  removeClaim: (id: string, version: number) =>
    request<null>('DELETE', `/expenses/claims/${id}?version=${version}`),
  submit: (id: string, version: number, acknowledgeDuplicates: boolean) =>
    request<Claim>('POST', `/expenses/claims/${id}/submit`, { version, acknowledgeDuplicates }),
  post: (id: string, version: number) =>
    request<Claim>('POST', `/expenses/claims/${id}/post`, { version }),
  cancel: (id: string, version: number) =>
    request<Claim>('POST', `/expenses/claims/${id}/cancel`, { version }),
  reverse: (id: string, version: number, reason: string) =>
    request<Claim>('POST', `/expenses/claims/${id}/reverse`, { version, reason }),
  advances: () => request<Page<Advance>>('GET', '/expenses/advances?limit=200'),
  issueAdvance: (body: {
    custodianId: string;
    amount: string;
    issuedOn: string;
    purpose: string;
  }) => request<Advance>('POST', '/expenses/advances', body),
  settleAdvance: (id: string, version: number, note: string) =>
    request<Advance>('POST', `/expenses/advances/${id}/settle`, {
      version,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    }),
  custodians: () => request<Custodian[]>('GET', '/expenses/custodians'),
  candidates: () => request<Candidate[]>('GET', '/expenses/custodian-candidates'),
  saveCustodian: (
    userId: string,
    body: { floatLimit: string; active: boolean; version?: number },
  ) => request<Custodian>('PUT', `/expenses/custodians/${userId}`, body),
  categories: () => request<Category[]>('GET', '/expenses/categories'),
  saveCategories: (categories: CategoryBody[]) =>
    request<Category[]>('PUT', '/expenses/categories', { categories }),
};
