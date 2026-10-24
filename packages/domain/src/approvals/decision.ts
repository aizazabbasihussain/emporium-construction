import { DomainError, RuleViolationError, ValidationError } from '../errors.js';
import type { StepDef } from './bands.js';
import { assertTransition, type RequestStatus } from './machine.js';

export type ApprovalActionType = 'approve' | 'reject' | 'return';

export interface RecordedAction {
  stepNo: number;
  actorId: string;
  action: ApprovalActionType;
}

export interface DecideInput {
  steps: readonly StepDef[];
  currentStep: number;
  requesterId: string;
  actorId: string;
  actorRoles: readonly string[];
  action: ApprovalActionType;
  comment: string | null;
  /** Actions already recorded on this request. */
  history: readonly RecordedAction[];
}

export interface DecideOutcome {
  status: RequestStatus;
  currentStep: number;
}

const forbidden = (code: string, message: string) => new DomainError('forbidden', code, message);

/**
 * Applies one approver action to a pending request and returns the new state (BR-2, BR-3, BR-4).
 * The caller persists the result; nothing here touches storage.
 */
export function decide(input: DecideInput): DecideOutcome {
  const step = input.steps.find((s) => s.stepNo === input.currentStep);
  if (step === undefined) {
    throw new RuleViolationError('step_not_found', 'The request has no such approval step');
  }
  if (input.actorId === input.requesterId) {
    throw forbidden('self_approval', 'You cannot act on your own approval request');
  }
  if (!input.actorRoles.includes(step.roleCode)) {
    throw forbidden('not_an_approver', `This step needs the ${step.roleCode} role`);
  }

  if (input.action !== 'approve') {
    if ((input.comment ?? '').trim() === '') {
      throw new ValidationError('comment_required', 'A comment is required');
    }
    const status = input.action === 'reject' ? 'rejected' : 'returned';
    assertTransition('pending', status);
    return { status, currentStep: input.currentStep };
  }

  const approvals = input.history.filter((h) => h.action === 'approve');
  if (approvals.some((h) => h.actorId === input.actorId)) {
    throw forbidden('already_approved', 'You already approved a step of this request');
  }
  const onThisStep = approvals.filter((h) => h.stepNo === step.stepNo).length + 1;
  if (onThisStep < step.minApprovers) {
    return { status: 'pending', currentStep: step.stepNo };
  }
  const next = input.steps.find((s) => s.stepNo > step.stepNo);
  if (next === undefined) {
    assertTransition('pending', 'approved');
    return { status: 'approved', currentStep: step.stepNo };
  }
  return { status: 'pending', currentStep: next.stepNo };
}
