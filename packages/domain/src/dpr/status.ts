import { RuleViolationError } from '../errors.js';

export const reportStatuses = ['draft', 'submitted', 'reviewed', 'reopened'] as const;
export type ReportStatus = (typeof reportStatuses)[number];

/**
 * Constitution 5.8, BR-5: the allowed report transitions as an explicit table. The author submits a
 * draft; the project manager reviews a submitted report or reopens it for correction, after which the
 * author edits and submits it again. A reviewed report is final.
 */
export const reportTransitions: Record<ReportStatus, readonly ReportStatus[]> = {
  draft: ['submitted'],
  submitted: ['reviewed', 'reopened'],
  reviewed: [],
  reopened: ['submitted'],
};

export function assertReportTransition(from: ReportStatus, to: ReportStatus): void {
  if (!reportTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'report_transition',
      `A daily progress report cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-5: a submitted report is read-only for the author; only a draft or a reopened one is edited. */
export const isEditable = (status: ReportStatus): boolean =>
  status === 'draft' || status === 'reopened';

export function assertReportEditable(status: ReportStatus): void {
  if (!isEditable(status)) {
    throw new RuleViolationError(
      'report_read_only',
      'Only a draft or reopened daily progress report can be edited',
    );
  }
}

/** BR-6: a report counts as filed for the day once it is submitted or reviewed. */
export function isFiled(status: ReportStatus): boolean {
  return status === 'submitted' || status === 'reviewed';
}
