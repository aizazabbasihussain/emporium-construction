import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const stageBases = ['percent', 'amount'] as const;
export type StageBasis = (typeof stageBases)[number];

export interface StageInput {
  name: string;
  basis: StageBasis;
  percent?: string | null | undefined;
  amount?: string | null | undefined;
  conditionText?: string | null | undefined;
}

export interface Stage {
  stageNo: number;
  name: string;
  basis: StageBasis;
  percent: string;
  amount: string;
  conditionText: string | null;
}

const decimalOf = (text: string | null | undefined, field: string, places: number): Decimal => {
  if (text === null || text === undefined || !/^-?\d+(\.\d+)?$/.test(text.trim())) {
    throw new ValidationError(`${field}_invalid`, `${field} must be a number`);
  }
  const value = new Dec(text.trim());
  if (value.decimalPlaces() > places) {
    throw new ValidationError(`${field}_precision`, `${field} allows at most ${places} decimals`);
  }
  return value;
};

/** BR-1: a quotation price is a positive amount with at most two decimals. */
export function normalizePrice(text: string | null | undefined): string {
  const price = decimalOf(text, 'price', 2);
  if (!price.greaterThan(0)) {
    throw new ValidationError('price_not_positive', 'The price must be greater than zero');
  }
  return price.toFixed(2);
}

/**
 * BR-3: the payment schedule of a lump-sum price. Percents must add up to exactly 100 (or amounts
 * to the price); amounts derive from the percent half-up and the remainder goes to the last
 * stage, so the amounts always add up to the price to the paisa.
 */
export function deriveStages(priceText: string, stages: readonly StageInput[]): Stage[] {
  const price = new Dec(priceText);
  const first = stages[0];
  if (first === undefined) {
    throw new ValidationError('stages_required', 'At least one payment stage is required');
  }
  if (stages.some((stage) => stage.basis !== first.basis)) {
    throw new ValidationError('stage_basis_mixed', 'All stages must use the same basis');
  }
  const names = stages.map((stage) => stage.name.trim());
  if (names.some((name) => name === '')) {
    throw new ValidationError('stage_name_required', 'Every stage needs a name');
  }
  const condition = (stage: StageInput) => {
    const text = stage.conditionText?.trim() ?? '';
    return text === '' ? null : text;
  };

  if (first.basis === 'amount') {
    const amounts = stages.map((stage) => decimalOf(stage.amount, 'stage_amount', 2));
    if (amounts.some((amount) => !amount.greaterThan(0))) {
      throw new ValidationError('stage_amount_not_positive', 'Stage amounts must be above zero');
    }
    const sum = amounts.reduce((total, amount) => total.plus(amount), new Dec(0));
    if (!sum.equals(price)) {
      throw new ValidationError('stage_amount_sum', 'Stage amounts must add up to the price');
    }
    return stages.map((stage, index) => {
      const amount = amounts[index] as Decimal;
      return {
        stageNo: index + 1,
        name: names[index] as string,
        basis: 'amount',
        percent: amount.div(price).times(100).toDecimalPlaces(4).toFixed(4),
        amount: amount.toFixed(2),
        conditionText: condition(stage),
      };
    });
  }

  const percents = stages.map((stage) => decimalOf(stage.percent, 'stage_percent', 4));
  if (percents.some((percent) => !percent.greaterThan(0) || percent.greaterThan(100))) {
    throw new ValidationError(
      'stage_percent_range',
      'A stage percent must be above 0 and at most 100',
    );
  }
  const total = percents.reduce((sum, percent) => sum.plus(percent), new Dec(0));
  if (!total.equals(100)) {
    throw new ValidationError('stage_percent_sum', 'Stage percents must add up to exactly 100');
  }
  let allocated = new Dec(0);
  return stages.map((stage, index) => {
    const last = index === stages.length - 1;
    const percent = percents[index] as Decimal;
    const amount = last ? price.minus(allocated) : price.times(percent).div(100).toDecimalPlaces(2);
    if (amount.isNegative()) {
      throw new ValidationError(
        'stage_amount_negative',
        'The stage split leaves a negative amount',
      );
    }
    allocated = allocated.plus(amount);
    return {
      stageNo: index + 1,
      name: names[index] as string,
      basis: 'percent',
      percent: percent.toFixed(4),
      amount: amount.toFixed(2),
      conditionText: condition(stage),
    };
  });
}
