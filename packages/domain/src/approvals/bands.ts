import { ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

/** An amount band: `minAmount` is inclusive and `maxAmount` is exclusive; null means no upper limit. */
export interface Band {
  minAmount: string;
  maxAmount: string | null;
}

export interface StepDef {
  stepNo: number;
  roleCode: string;
  minApprovers: number;
}

const parse = (value: string, what: string): Money => {
  try {
    return Money.of(value);
  } catch {
    throw new ValidationError('invalid_amount', `${what} is not a valid amount`);
  }
};

/**
 * BR-8: bands for one document type start at 0, do not overlap and leave no gap. The band that
 * contains an amount is found with min inclusive and max exclusive (T-1).
 */
export function validateBands(bands: readonly Band[]): void {
  if (bands.length === 0) {
    throw new ValidationError('bands_empty', 'At least one amount band is required');
  }
  const parsed = bands
    .map((band) => ({
      min: parse(band.minAmount, 'Minimum amount'),
      max: band.maxAmount === null ? null : parse(band.maxAmount, 'Maximum amount'),
    }))
    .sort((a, b) => a.min.compare(b.min));

  let expectedMin = Money.zero();
  let previousOpen = false;
  for (const { min, max } of parsed) {
    if (min.isNegative() || (max !== null && max.isNegative())) {
      throw new ValidationError('band_negative', 'Amounts must not be negative');
    }
    if (previousOpen || min.compare(expectedMin) < 0) {
      throw new ValidationError('band_overlap', `Bands overlap at ${min.toString()}`);
    }
    if (min.compare(expectedMin) > 0) {
      throw new ValidationError(
        'band_gap',
        `There is a gap between ${expectedMin.toString()} and ${min.toString()}`,
      );
    }
    if (max === null) {
      previousOpen = true;
    } else {
      if (max.compare(min) <= 0) {
        throw new ValidationError('band_empty', 'A band maximum must be above its minimum');
      }
      expectedMin = max;
    }
  }
}

/** The first band containing the amount (min inclusive, max exclusive), or undefined. */
export function selectBand<T extends Band>(bands: readonly T[], amount: string): T | undefined {
  const value = parse(amount, 'Amount');
  if (value.isNegative()) {
    throw new ValidationError('amount_negative', 'The amount must not be negative');
  }
  return bands.find(
    (band) =>
      value.compare(Money.of(band.minAmount)) >= 0 &&
      (band.maxAmount === null || value.compare(Money.of(band.maxAmount)) < 0),
  );
}

/** Steps run in order 1..n; every step needs a role and at least one approver. */
export function validateSteps(steps: readonly StepDef[]): void {
  if (steps.length === 0) {
    throw new ValidationError('steps_empty', 'At least one approval step is required');
  }
  steps.forEach((step, index) => {
    if (step.stepNo !== index + 1) {
      throw new ValidationError('steps_not_sequential', 'Steps must be numbered 1, 2, 3 in order');
    }
    if (step.roleCode.trim() === '') {
      throw new ValidationError('step_role_required', 'Every step needs a role');
    }
    if (!Number.isInteger(step.minApprovers) || step.minApprovers < 1) {
      throw new ValidationError('step_approvers_invalid', 'A step needs at least one approver');
    }
  });
}
