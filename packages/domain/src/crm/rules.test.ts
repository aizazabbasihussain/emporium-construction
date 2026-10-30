import { describe, expect, it } from 'vitest';
import { fixedClock } from '../kernel/index.js';
import {
  assertContactPresent,
  assertLeadEditable,
  assertOnlyNotesChanged,
  assertVisitDate,
  conversionRate,
  isOverdue,
  normalizeExpectedValue,
  planStageMove,
  reminderInstant,
  sumExpectedValue,
  summarizePipeline,
  type StageMove,
} from './rules.js';

const open = (code: string) => ({ code, kind: 'open' as const });
const won = { code: 'won', kind: 'won' as const };
const lost = { code: 'lost', kind: 'lost' as const };

const move = (overrides: Partial<StageMove>): StageMove => ({
  from: open('new'),
  to: open('visited'),
  hasParty: true,
  lossReason: null,
  canReopen: false,
  ...overrides,
});

describe('stage moves (BR-2, BR-3, T-1)', () => {
  it('moves forward and backward among open stages', () => {
    const forward = planStageMove(move({}));
    expect(forward).toEqual({ reopens: false, needsParty: false, closes: null });
    expect(planStageMove(move({ from: open('quoted'), to: open('new') }))).toEqual(forward);
  });

  it('refuses a move to the same stage', () => {
    expect(() => planStageMove(move({ to: open('new') }))).toThrow(
      expect.objectContaining({ code: 'stage_unchanged' }),
    );
  });

  it('wins with a party and asks for one when the lead has none', () => {
    expect(planStageMove(move({ to: won }))).toEqual({
      reopens: false,
      needsParty: false,
      closes: 'won',
    });
    expect(planStageMove(move({ to: won, hasParty: false })).needsParty).toBe(true);
  });

  it('loses only with a reason', () => {
    expect(() => planStageMove(move({ to: lost }))).toThrow(
      expect.objectContaining({ code: 'loss_reason_required' }),
    );
    expect(() => planStageMove(move({ to: lost, lossReason: '  ' }))).toThrow(
      expect.objectContaining({ code: 'loss_reason_required' }),
    );
    expect(planStageMove(move({ to: lost, lossReason: 'price' })).closes).toBe('lost');
  });

  it('keeps closed leads closed without the reopen permission', () => {
    expect(() => planStageMove(move({ from: won, to: open('new') }))).toThrow(
      expect.objectContaining({ code: 'lead_closed' }),
    );
    expect(() => planStageMove(move({ from: lost, to: won }))).toThrow(
      expect.objectContaining({ code: 'lead_closed' }),
    );
  });

  it('reopens a closed lead into an open stage with the permission', () => {
    expect(planStageMove(move({ from: lost, to: open('new'), canReopen: true }))).toEqual({
      reopens: true,
      needsParty: false,
      closes: null,
    });
  });

  it('does not switch between closed stages even with the permission', () => {
    expect(() => planStageMove(move({ from: won, to: lost, canReopen: true }))).toThrow(
      expect.objectContaining({ code: 'reopen_to_open_stage' }),
    );
  });
});

describe('closed leads are read-only except notes (BR-2)', () => {
  it('lets open leads change anything', () => {
    expect(() => assertLeadEditable('open')).not.toThrow();
    expect(() => assertOnlyNotesChanged('open', ['sector', 'description'])).not.toThrow();
  });

  it('refuses edits of a closed lead', () => {
    expect(() => assertLeadEditable('won')).toThrow(
      expect.objectContaining({ code: 'lead_closed' }),
    );
    expect(() => assertLeadEditable('lost')).toThrow(
      expect.objectContaining({ code: 'lead_closed' }),
    );
  });

  it('lets a closed lead change its notes only', () => {
    expect(() => assertOnlyNotesChanged('won', [])).not.toThrow();
    expect(() => assertOnlyNotesChanged('won', ['description'])).not.toThrow();
    expect(() => assertOnlyNotesChanged('lost', ['description', 'sector'])).toThrow(
      expect.objectContaining({ code: 'lead_closed' }),
    );
  });
});

describe('contact details (BR-1)', () => {
  it('needs name and phone without a party', () => {
    expect(() =>
      assertContactPresent({ partyId: null, contactName: 'Ali', contactPhone: null }),
    ).toThrow(expect.objectContaining({ code: 'contact_required' }));
    expect(() =>
      assertContactPresent({ partyId: null, contactName: null, contactPhone: '+923001234567' }),
    ).toThrow(expect.objectContaining({ code: 'contact_required' }));
    expect(() =>
      assertContactPresent({ partyId: null, contactName: 'Ali', contactPhone: '+923001234567' }),
    ).not.toThrow();
  });

  it('needs nothing with a party', () => {
    expect(() =>
      assertContactPresent({ partyId: 'p', contactName: null, contactPhone: null }),
    ).not.toThrow();
  });
});

describe('follow-up reminders and overdue flags (BR-4, BR-5, T-2, T-3)', () => {
  it('is due at 09:00 Asia/Karachi, which is 04:00 UTC the same day', () => {
    expect(reminderInstant('2026-10-26').toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(reminderInstant('2026-01-01').toISOString()).toBe('2026-01-01T04:00:00.000Z');
  });

  it('rejects a date that does not exist', () => {
    expect(() => reminderInstant('2026-02-30')).toThrow(
      expect.objectContaining({ code: 'invalid_date' }),
    );
  });

  it('flags an open follow-up only after its due date, using the Karachi day', () => {
    const followUp = { dueDate: '2026-10-25', status: 'open' };
    // 18:59 UTC on 25 Oct is still 25 Oct in Karachi.
    expect(isOverdue(followUp, fixedClock('2026-10-25T18:59:59Z'))).toBe(false);
    // 19:00 UTC is 00:00 on 26 Oct in Karachi, so the follow-up is now overdue.
    expect(isOverdue(followUp, fixedClock('2026-10-25T19:00:00Z'))).toBe(true);
    expect(isOverdue(followUp, fixedClock('2026-10-24T20:00:00Z'))).toBe(false);
  });

  it('never flags a follow-up that is not open', () => {
    const clock = fixedClock('2026-12-01T00:00:00Z');
    expect(isOverdue({ dueDate: '2026-10-25', status: 'done' }, clock)).toBe(false);
    expect(isOverdue({ dueDate: '2026-10-25', status: 'cancelled' }, clock)).toBe(false);
  });
});

describe('site visit dates (BR-7)', () => {
  const clock = fixedClock('2026-10-25T20:00:00Z'); // 26 Oct 01:00 in Karachi
  it('accepts today and the past in Asia/Karachi', () => {
    expect(() => assertVisitDate('2026-10-26', clock)).not.toThrow();
    expect(() => assertVisitDate('2026-10-01', clock)).not.toThrow();
  });
  it('refuses tomorrow', () => {
    expect(() => assertVisitDate('2026-10-27', clock)).toThrow(
      expect.objectContaining({ code: 'visit_in_future' }),
    );
  });
});

describe('expected value', () => {
  it('is normalized to two decimals', () => {
    expect(normalizeExpectedValue('5000')).toBe('5000.00');
    expect(normalizeExpectedValue(' 5000.5 ')).toBe('5000.50');
    expect(normalizeExpectedValue('0.07')).toBe('0.07');
  });
  it('refuses anything that is not an amount', () => {
    for (const bad of ['', '-5', '1.234', 'abc', '1,000', '12345678901234567']) {
      expect(() => normalizeExpectedValue(bad), bad).toThrow(
        expect.objectContaining({ code: 'invalid_expected_value' }),
      );
    }
  });
  it('sums without rounding error', () => {
    expect(sumExpectedValue([])).toBe('0.00');
    expect(sumExpectedValue(['0.10', '0.20', null])).toBe('0.30');
    expect(sumExpectedValue(['100', '2.5'])).toBe('102.50');
    expect(sumExpectedValue(['1.005'])).toBe('1.00');
  });
});

describe('conversion rate (P1-19 BR-6)', () => {
  it('is won over won plus lost as a percentage with two decimals', () => {
    expect(conversionRate(1, 2)).toBe('33.33');
    expect(conversionRate(2, 1)).toBe('66.67');
    expect(conversionRate(3, 0)).toBe('100.00');
    expect(conversionRate(0, 4)).toBe('0.00');
    expect(conversionRate(1, 7)).toBe('12.50');
  });

  it('is empty when nothing was closed', () => {
    expect(conversionRate(0, 0)).toBeNull();
  });
});

describe('pipeline aggregation (AC-4, T-5)', () => {
  it('lists every stage in order with count and value', () => {
    const rows = summarizePipeline(
      ['new', 'quoted', 'won'],
      [
        { stageCode: 'new', expectedValue: '1000.00' },
        { stageCode: 'new', expectedValue: null },
        { stageCode: 'won', expectedValue: '250.50' },
      ],
    );
    expect(rows).toEqual([
      { stageCode: 'new', count: 2, expectedValue: '1000.00' },
      { stageCode: 'quoted', count: 0, expectedValue: '0.00' },
      { stageCode: 'won', count: 1, expectedValue: '250.50' },
    ]);
  });
});
