import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate, type Clock } from '../kernel/index.js';

export type StageKind = 'open' | 'won' | 'lost';

export interface StageRef {
  code: string;
  kind: StageKind;
}

export interface StageMove {
  from: StageRef;
  to: StageRef;
  hasParty: boolean;
  lossReason: string | null;
  canReopen: boolean;
}

export interface StageMovePlan {
  /** Won and lost leads reopen only with `crm.lead.reopen`. */
  reopens: boolean;
  /** BR-2: the move needs a party; the service creates one from the contact when the lead has none. */
  needsParty: boolean;
  closes: StageKind | null;
}

/**
 * BR-2, BR-3: open stages move freely forward and backward; a lost stage needs a reason; a won stage
 * needs a party; a closed lead leaves its stage only through reopening.
 */
export function planStageMove(move: StageMove): StageMovePlan {
  const { from, to } = move;
  if (from.code === to.code) {
    throw new RuleViolationError('stage_unchanged', 'The lead is already in this stage');
  }
  const reopens = from.kind !== 'open';
  if (reopens && !move.canReopen) {
    throw new RuleViolationError('lead_closed', 'A won or lost lead can only be reopened');
  }
  if (reopens && to.kind !== 'open') {
    throw new RuleViolationError('reopen_to_open_stage', 'Reopen a closed lead into an open stage');
  }
  if (to.kind === 'lost' && (move.lossReason ?? '').trim() === '') {
    throw new ValidationError('loss_reason_required', 'A lost lead needs a loss reason');
  }
  return {
    reopens,
    needsParty: to.kind === 'won' && !move.hasParty,
    closes: to.kind === 'open' ? null : to.kind,
  };
}

/** BR-2: a closed lead accepts notes only. */
export function assertLeadEditable(kind: StageKind): void {
  if (kind !== 'open') {
    throw new RuleViolationError('lead_closed', 'A won or lost lead is read-only');
  }
}

/** BR-2: on a closed lead only the notes (the description) may change. */
export function assertOnlyNotesChanged(kind: StageKind, changedFields: readonly string[]): void {
  if (kind !== 'open' && changedFields.some((field) => field !== 'description')) {
    assertLeadEditable(kind);
  }
}

/** BR-1: a lead without a linked party must carry the contact name and phone. */
export function assertContactPresent(input: {
  partyId: string | null;
  contactName: string | null;
  contactPhone: string | null;
}): void {
  if (input.partyId !== null) return;
  if (input.contactName === null || input.contactPhone === null) {
    throw new ValidationError(
      'contact_required',
      'A lead without a client needs a contact name and phone',
    );
  }
}

/** BR-4: the reminder is due at 09:00 Asia/Karachi (UTC+5, no daylight saving) on the due date. */
export function reminderInstant(dueDate: string): Date {
  const date = BusinessDate.parse(dueDate);
  return new Date(`${date.toString()}T04:00:00.000Z`);
}

/** BR-5: an open follow-up is overdue when its due date is before today in Asia/Karachi. */
export function isOverdue(followUp: { dueDate: string; status: string }, clock: Clock): boolean {
  return (
    followUp.status === 'open' &&
    BusinessDate.today(clock).isAfter(BusinessDate.parse(followUp.dueDate))
  );
}

/** BR-7: a visit cannot be dated in the future. */
export function assertVisitDate(visitDate: string, clock: Clock): void {
  const date = BusinessDate.parse(visitDate);
  if (date.isAfter(BusinessDate.today(clock))) {
    throw new RuleViolationError('visit_in_future', 'A site visit cannot be dated in the future');
  }
}

export interface PipelineLead {
  stageCode: string;
  expectedValue: string | null;
}

export interface PipelineRow {
  stageCode: string;
  count: number;
  expectedValue: string;
}

/** The expected value is money with at most two decimals, stored as text with exactly two. */
export function normalizeExpectedValue(text: string): string {
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) {
    throw new ValidationError('invalid_expected_value', 'The expected value is not a valid amount');
  }
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}

/** Sums amounts held as text with two decimals, without floating point. */
export function sumExpectedValue(values: readonly (string | null)[]): string {
  const cents = values.reduce((sum, value) => sum + toCents(value), 0n);
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${cents / 100n}.${fraction}`;
}

/** AC-4: counts and expected value per stage, in stage order, including stages that hold no lead. */
export function summarizePipeline(
  stageCodes: readonly string[],
  leads: readonly PipelineLead[],
): PipelineRow[] {
  return stageCodes.map((stageCode) => {
    const inStage = leads.filter((lead) => lead.stageCode === stageCode);
    return {
      stageCode,
      count: inStage.length,
      expectedValue: sumExpectedValue(inStage.map((lead) => lead.expectedValue)),
    };
  });
}

/**
 * P1-19 BR-6: the conversion rate of a period, won / (won + lost) as a percentage to two decimals,
 * rounded half up. Leads still open are not part of it; null when nothing was won or lost.
 */
export function conversionRate(won: number, lost: number): string | null {
  const closed = BigInt(won + lost);
  if (closed === 0n) return null;
  const hundredths = (BigInt(won) * 20000n + closed) / (closed * 2n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

function toCents(value: string | null): bigint {
  if (value === null) return 0n;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}
