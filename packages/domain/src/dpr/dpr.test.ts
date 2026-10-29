import { describe, expect, it } from 'vitest';
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  assertPhotoCapacity,
  assertPhotosForSubmit,
  assertReportEditable,
  assertReportTransition,
  assertWorkDone,
  checkTaskUpdate,
  isFiled,
  isPastDeadline,
  isPhotoSizeAllowed,
  isSiteHoliday,
  normalizeManpower,
  parseSiteHolidays,
  reportStatuses,
  reportTransitions,
  selectMissing,
  type ReportStatus,
} from './index.js';

describe('report status machine (BR-5, T-3)', () => {
  it('allows exactly the transitions in the table and refuses every other pair', () => {
    for (const from of reportStatuses) {
      for (const to of reportStatuses) {
        const allowed = reportTransitions[from].includes(to);
        if (allowed) expect(() => assertReportTransition(from, to), `${from}>${to}`).not.toThrow();
        else expect(() => assertReportTransition(from, to), `${from}>${to}`).toThrow(/cannot go/);
      }
    }
  });

  it('walks the reopen cycle: submit, reopen, submit again, review', () => {
    const path: ReportStatus[] = ['draft', 'submitted', 'reopened', 'submitted', 'reviewed'];
    for (let i = 1; i < path.length; i += 1) {
      expect(() =>
        assertReportTransition(path[i - 1] as ReportStatus, path[i] as ReportStatus),
      ).not.toThrow();
    }
    expect(reportTransitions.reviewed).toEqual([]);
  });

  it('lets only a draft or a reopened report be edited', () => {
    expect(() => assertReportEditable('draft')).not.toThrow();
    expect(() => assertReportEditable('reopened')).not.toThrow();
    expect(() => assertReportEditable('submitted')).toThrow(/edited/);
    expect(() => assertReportEditable('reviewed')).toThrow(/edited/);
  });

  it('counts a submitted or reviewed report as filed', () => {
    expect(reportStatuses.filter(isFiled)).toEqual(['submitted', 'reviewed']);
  });
});

describe('submit validation (BR-3, T-2)', () => {
  it('needs ten characters of work done once trimmed', () => {
    expect(() => assertWorkDone('Poured slab')).not.toThrow();
    expect(() => assertWorkDone('   short   ')).toThrow(/10 characters/);
    expect(() => assertWorkDone('')).toThrow(/10 characters/);
    expect(() => assertWorkDone('1234567890')).not.toThrow();
    expect(() => assertWorkDone('123456789')).toThrow();
  });

  it('needs a photo unless the setting is off', () => {
    expect(() => assertPhotosForSubmit(0, true)).toThrow(/photo/);
    expect(() => assertPhotosForSubmit(1, true)).not.toThrow();
    expect(() => assertPhotosForSubmit(0, false)).not.toThrow();
  });
});

describe('photo limits (BR-7, T-6)', () => {
  it('accepts up to twenty photos', () => {
    expect(() => assertPhotoCapacity(MAX_PHOTOS - 1)).not.toThrow();
    expect(() => assertPhotoCapacity(MAX_PHOTOS)).toThrow(/at most 20/);
  });

  it('accepts a photo of at most 10 MB', () => {
    expect(isPhotoSizeAllowed(MAX_PHOTO_BYTES)).toBe(true);
    expect(isPhotoSizeAllowed(MAX_PHOTO_BYTES + 1)).toBe(false);
    expect(isPhotoSizeAllowed(0)).toBe(false);
  });
});

describe('task updates (BR-4, T-4)', () => {
  const update = (percentComplete: number, note?: string | null) => ({
    taskId: 't1',
    percentComplete,
    note,
  });

  it('accepts a rise, a repeat and a fall with a note', () => {
    expect(checkTaskUpdate(update(60), 40)).toEqual({
      taskId: 't1',
      percentComplete: 60,
      note: null,
    });
    expect(checkTaskUpdate(update(40, ' '), 40).note).toBeNull();
    expect(checkTaskUpdate(update(20, ' Rework after rain '), 40).note).toBe('Rework after rain');
  });

  it('refuses a fall without a note', () => {
    expect(() => checkTaskUpdate(update(20), 40)).toThrow(/needs a note/);
    expect(() => checkTaskUpdate(update(20, null), 40)).toThrow(/needs a note/);
    expect(() => checkTaskUpdate(update(20, '  '), 40)).toThrow(/needs a note/);
  });

  it('refuses a percent that is not a whole number from 0 to 100', () => {
    for (const bad of [-1, 101, 12.5, Number.NaN]) {
      expect(() => checkTaskUpdate(update(bad), 0), String(bad)).toThrow(/whole number/);
    }
    expect(checkTaskUpdate(update(0), 0).percentComplete).toBe(0);
    expect(checkTaskUpdate(update(100), 0).percentComplete).toBe(100);
  });
});

describe('manpower', () => {
  it('trims trades and keeps whole counts', () => {
    expect(normalizeManpower([{ trade: ' Mason ', count: 4 }])).toEqual([
      { trade: 'Mason', count: 4 },
    ]);
    expect(normalizeManpower([])).toEqual([]);
  });

  it('refuses a blank trade, a negative or fractional count', () => {
    expect(() => normalizeManpower([{ trade: ' ', count: 1 }])).toThrow(/trade/);
    expect(() => normalizeManpower([{ trade: 'Mason', count: -1 }])).toThrow(/trade/);
    expect(() => normalizeManpower([{ trade: 'Mason', count: 1.5 }])).toThrow(/trade/);
  });
});

describe('missing reports and the deadline (BR-6, T-5)', () => {
  it('parses holidays and ignores malformed entries', () => {
    expect(parseSiteHolidays('')).toEqual([]);
    expect(parseSiteHolidays(' 2026-10-30 , nope,2026-11-01,')).toEqual([
      '2026-10-30',
      '2026-11-01',
    ]);
    expect(isSiteHoliday('2026-10-30', '2026-10-29,2026-10-30')).toBe(true);
    expect(isSiteHoliday('2026-10-31', '2026-10-29,2026-10-30')).toBe(false);
  });

  it('is past the deadline from 18:00 Karachi (13:00 UTC) on', () => {
    expect(isPastDeadline(new Date('2026-10-29T12:59:59Z'))).toBe(false);
    expect(isPastDeadline(new Date('2026-10-29T13:00:00Z'))).toBe(true);
    expect(isPastDeadline(new Date('2026-10-29T18:59:59Z'))).toBe(true);
    // 19:00Z is already past midnight in Karachi, a new day before 18:00.
    expect(isPastDeadline(new Date('2026-10-29T19:00:00Z'))).toBe(false);
    expect(isPastDeadline(new Date('1969-12-31T13:00:00Z'))).toBe(true);
  });

  it('keeps projects with a supervisor and no filed report', () => {
    const projects = [
      { projectId: 'a', supervisorIds: ['s1'] },
      { projectId: 'b', supervisorIds: ['s2'] },
      { projectId: 'c', supervisorIds: [] },
    ];
    expect(selectMissing(projects, new Set(['b'])).map((p) => p.projectId)).toEqual(['a']);
    expect(selectMissing(projects, new Set())).toHaveLength(2);
    expect(selectMissing([], new Set())).toEqual([]);
  });
});
