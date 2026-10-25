import { describe, expect, it } from 'vitest';
import type { ValidationError } from '../errors.js';
import { deriveStages, normalizePrice, type StageInput } from './stages.js';

const pct = (name: string, percent: string, conditionText?: string): StageInput => ({
  name,
  basis: 'percent',
  percent,
  conditionText,
});
const amt = (name: string, amount: string): StageInput => ({ name, basis: 'amount', amount });

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as ValidationError).code;
  }
  return undefined;
};

describe('normalizePrice (BR-1)', () => {
  it('accepts a positive amount and pads to two decimals', () => {
    expect(normalizePrice('1000')).toBe('1000.00');
    expect(normalizePrice(' 12.5 ')).toBe('12.50');
  });

  it('rejects zero, negative, text, missing and over-precise prices', () => {
    expect(codeOf(() => normalizePrice('0'))).toBe('price_not_positive');
    expect(codeOf(() => normalizePrice('-5'))).toBe('price_not_positive');
    expect(codeOf(() => normalizePrice('abc'))).toBe('price_invalid');
    expect(codeOf(() => normalizePrice(null))).toBe('price_invalid');
    expect(codeOf(() => normalizePrice(undefined))).toBe('price_invalid');
    expect(codeOf(() => normalizePrice('1.001'))).toBe('price_precision');
  });
});

describe('deriveStages by percent (BR-3)', () => {
  it('splits the price and keeps the remainder in the last stage', () => {
    const stages = deriveStages('100.00', [
      pct('Advance', '33.3333', ' on signing '),
      pct('Roof', '33.3333'),
      pct('Handover', '33.3334', ''),
    ]);
    expect(stages.map((s) => s.amount)).toEqual(['33.33', '33.33', '33.34']);
    expect(stages.map((s) => s.stageNo)).toEqual([1, 2, 3]);
    expect(stages[0]?.conditionText).toBe('on signing');
    expect(stages[2]?.conditionText).toBeNull();
    expect(stages[0]?.percent).toBe('33.3333');
  });

  it('rounds half-up before giving the rest to the last stage', () => {
    const stages = deriveStages('0.10', [pct('A', '25'), pct('B', '75')]);
    // 0.10 * 25% = 0.025 rounds up to 0.03; the last stage gets 0.07.
    expect(stages.map((s) => s.amount)).toEqual(['0.03', '0.07']);
  });

  it('accepts a single stage of 100 percent', () => {
    expect(deriveStages('5.00', [pct('All', '100')]).map((s) => s.amount)).toEqual(['5.00']);
  });

  it('rejects percents that do not add up to exactly 100', () => {
    expect(codeOf(() => deriveStages('100.00', [pct('A', '50'), pct('B', '49.9999')]))).toBe(
      'stage_percent_sum',
    );
    expect(codeOf(() => deriveStages('100.00', [pct('A', '60'), pct('B', '50')]))).toBe(
      'stage_percent_sum',
    );
  });

  it('rejects percents outside 0 to 100, with too many decimals, or not numbers', () => {
    expect(codeOf(() => deriveStages('10.00', [pct('A', '0'), pct('B', '100')]))).toBe(
      'stage_percent_range',
    );
    expect(codeOf(() => deriveStages('10.00', [pct('A', '101')]))).toBe('stage_percent_range');
    expect(codeOf(() => deriveStages('10.00', [pct('A', '50.00001'), pct('B', '49.99999')]))).toBe(
      'stage_percent_precision',
    );
    expect(codeOf(() => deriveStages('10.00', [pct('A', 'x')]))).toBe('stage_percent_invalid');
    expect(codeOf(() => deriveStages('10.00', [{ name: 'A', basis: 'percent' }]))).toBe(
      'stage_percent_invalid',
    );
  });

  it('rejects a split whose rounding leaves a negative last stage', () => {
    expect(
      codeOf(() =>
        deriveStages('0.02', [pct('A', '25'), pct('B', '25'), pct('C', '25'), pct('D', '25')]),
      ),
    ).toBe('stage_amount_negative');
  });
});

describe('deriveStages by amount (BR-3)', () => {
  it('accepts amounts that add up to the price and derives the percents', () => {
    const stages = deriveStages('300.00', [amt('A', '100'), amt('B', '200.00')]);
    expect(stages.map((s) => s.amount)).toEqual(['100.00', '200.00']);
    expect(stages.map((s) => s.percent)).toEqual(['33.3333', '66.6667']);
    expect(stages[0]?.basis).toBe('amount');
  });

  it('rejects amounts that do not add up, are not positive, or are over-precise', () => {
    expect(codeOf(() => deriveStages('300.00', [amt('A', '100'), amt('B', '199.99')]))).toBe(
      'stage_amount_sum',
    );
    expect(codeOf(() => deriveStages('300.00', [amt('A', '0'), amt('B', '300')]))).toBe(
      'stage_amount_not_positive',
    );
    expect(codeOf(() => deriveStages('300.00', [amt('A', '300.001')]))).toBe(
      'stage_amount_precision',
    );
  });
});

describe('deriveStages common checks', () => {
  it('needs at least one stage', () => {
    expect(codeOf(() => deriveStages('10.00', []))).toBe('stages_required');
  });

  it('needs one basis for the whole schedule', () => {
    expect(codeOf(() => deriveStages('10.00', [pct('A', '50'), amt('B', '5')]))).toBe(
      'stage_basis_mixed',
    );
  });

  it('needs a name for every stage', () => {
    expect(codeOf(() => deriveStages('10.00', [pct('  ', '100')]))).toBe('stage_name_required');
  });
});
