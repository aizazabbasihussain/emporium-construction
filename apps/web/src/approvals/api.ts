import type { ApprovalAction, ApprovalStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface ApprovalStep {
  stepNo: number;
  roleCode: string;
  minApprovers: number;
}

export interface ApprovalActionItem {
  stepNo: number;
  actorId: string;
  action: ApprovalAction;
  comment: string | null;
  at: string;
}

export interface ApprovalRequest {
  id: string;
  docType: string;
  docId: string;
  revision: number;
  amount: string;
  requesterId: string;
  status: ApprovalStatus;
  currentStep: number;
  currentRole: string | null;
  submittedAt: string;
  version: number;
  steps: ApprovalStep[];
  actions: ApprovalActionItem[];
}

export interface RuleBand {
  minAmount: string;
  maxAmount: string | null;
  steps: ApprovalStep[];
}

export interface RuleSet {
  effectiveFrom: string;
  bands: RuleBand[];
}

export const approvalsApi = {
  inbox: () => request<{ items: ApprovalRequest[] }>('GET', '/approvals/inbox'),
  detail: (id: string) => request<ApprovalRequest>('GET', `/approvals/requests/${id}`),
  act: (id: string, action: ApprovalAction, comment: string, version: number) =>
    request<ApprovalRequest>('POST', `/approvals/requests/${id}/${action}`, {
      comment: comment.trim() === '' ? null : comment.trim(),
      version,
    }),
  docTypes: () => request<{ items: string[] }>('GET', '/admin/approval-rules'),
  rules: (docType: string) =>
    request<{ docType: string; sets: RuleSet[] }>('GET', `/admin/approval-rules/${docType}`),
  saveRules: (docType: string, set: RuleSet) =>
    request<{ docType: string; sets: RuleSet[] }>('PUT', `/admin/approval-rules/${docType}`, set),
};
