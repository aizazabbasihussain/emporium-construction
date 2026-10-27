import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkRanges } from '../src/decisions/index.js';

const day = (offset: number): string =>
  new Date(Date.UTC(2020, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

/** Builds ranges that never touch: each starts at least one day after the previous one ends. */
const separate = fc
  .array(
    fc.record({ gap: fc.integer({ min: 1, max: 30 }), length: fc.integer({ min: 0, max: 60 }) }),
    {
      minLength: 1,
      maxLength: 8,
    },
  )
  .chain((steps) => fc.tuple(fc.constant(steps), fc.boolean()));

const toRanges = (steps: { gap: number; length: number }[], openLast: boolean) => {
  let cursor = 0;
  return steps.map((step, index) => {
    const from = cursor + step.gap;
    const to = from + step.length;
    cursor = to;
    const open = openLast && index === steps.length - 1;
    return {
      row: index + 2,
      key: 'k',
      from: day(from),
      to: open ? '' : day(to),
      start: from,
      end: to,
    };
  });
};

describe('checkRanges (T-4)', () => {
  it('accepts any non-overlapping rule set', () => {
    fc.assert(
      fc.property(separate, ([steps, openLast]) => {
        const ranges = toRanges(steps, openLast);
        expect(checkRanges('f.csv', ranges)).toEqual([]);
      }),
    );
  });

  it('rejects a set once one range starts inside another', () => {
    fc.assert(
      fc.property(separate, fc.nat(), ([steps, openLast], pick) => {
        const ranges = toRanges(steps, openLast);
        const target = ranges[pick % ranges.length];
        if (!target) throw new Error('no ranges');
        const intruder = { row: 99, key: 'k', from: target.from, to: '' };
        const issues = checkRanges('f.csv', [...ranges, intruder]);
        expect(issues.length).toBeGreaterThan(0);
      }),
    );
  });
});
