import { RuleViolationError, ValidationError } from '../errors.js';

export const pdcStatuses = [
  'received',
  'deposited',
  'cleared',
  'bounced',
  'returned',
  'replaced',
] as const;
export type PdcStatus = (typeof pdcStatuses)[number];

export const pdcActions = ['deposit', 'clear', 'bounce', 'return', 'replace'] as const;
export type PdcAction = (typeof pdcActions)[number];

/**
 * BR-6 and AC-2: the allowed moves of a cheque. A bank can still return a cheque it credited, so a
 * cleared cheque may bounce (the cash movement is then reversed); returned and replaced end its life.
 */
export const pdcTransitions: Record<PdcStatus, Partial<Record<PdcAction, PdcStatus>>> = {
  received: { deposit: 'deposited', return: 'returned', replace: 'replaced' },
  deposited: { clear: 'cleared', bounce: 'bounced' },
  cleared: { bounce: 'bounced' },
  bounced: { return: 'returned', replace: 'replaced' },
  returned: {},
  replaced: {},
};

export function nextPdcStatus(from: PdcStatus, action: PdcAction): PdcStatus {
  const to = pdcTransitions[from][action];
  if (to === undefined) {
    throw new RuleViolationError(
      'pdc_transition_forbidden',
      `A cheque that is ${from} cannot be moved by "${action}"`,
    );
  }
  return to;
}

/**
 * BR-6: a cheque is not deposited before its date unless the accountant gives a reason.
 * Returns the reason that was used (null when none was needed).
 */
export function assertDepositable(
  chequeDate: string,
  today: string,
  overrideReason: string | undefined,
): string | null {
  if (chequeDate <= today) return null;
  const reason = overrideReason?.trim() ?? '';
  if (reason === '') {
    throw new RuleViolationError(
      'pdc_before_cheque_date',
      `The cheque is dated ${chequeDate}; depositing earlier needs a reason`,
    );
  }
  return reason;
}

/** BR-7 and T-8: 09:00 Asia/Karachi (04:00 UTC) or later. */
export function isReminderTime(now: Date): boolean {
  return now.getUTCHours() >= 4;
}

/** BR-7: cheques dated from today up to the window end (the seventh day after today) are due soon. */
export function isUpcoming(chequeDate: string, today: string, windowEnd: string): boolean {
  return chequeDate >= today && chequeDate <= windowEnd;
}

export function assertChequeDetails(input: {
  chequeNumber: string | undefined;
  bankName: string | undefined;
  chequeDate: string | undefined;
}): void {
  if ((input.chequeNumber?.trim() ?? '') === '' || (input.bankName?.trim() ?? '') === '') {
    throw new ValidationError('cheque_details_required', 'Cheque number and bank are required');
  }
  if (input.chequeDate === undefined) {
    throw new ValidationError('cheque_date_required', 'The cheque date is required');
  }
}
