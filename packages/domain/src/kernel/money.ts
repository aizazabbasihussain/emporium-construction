import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = string | number | bigint | Decimal;

/** Parse a decimal input. Floats (non-integer numbers) are rejected so no binary rounding enters. */
function parse(value: unknown, what: string): Decimal {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('float_rejected', `${what} must not be built from a float`);
    }
    return new Dec(value);
  }
  if (typeof value === 'bigint') return new Dec(value.toString());
  if (value instanceof Decimal) return new Dec(value);
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return new Dec(value.trim());
  }
  throw new ValidationError('invalid_decimal', `${what} is not a valid decimal`);
}

/** Fixed-scale decimal. Arithmetic between values of one type stays exact. */
abstract class Scaled<Self extends Scaled<Self>> {
  protected abstract readonly scale: number;
  readonly value: Decimal;

  protected constructor(value: Decimal) {
    this.value = value;
  }

  protected abstract make(value: Decimal): Self;

  add(other: Self): Self {
    return this.make(this.value.plus(other.value));
  }
  sub(other: Self): Self {
    return this.make(this.value.minus(other.value));
  }
  negate(): Self {
    return this.make(this.value.neg());
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  compare(other: Self): number {
    return this.value.comparedTo(other.value);
  }
  equals(other: Self): boolean {
    return this.value.equals(other.value);
  }
  toString(): string {
    return this.value.toFixed(this.scale, Decimal.ROUND_HALF_UP);
  }
  toJSON(): string {
    return this.toString();
  }
}

/** An exact intermediate amount; only `roundMoney()` turns it back into Money. */
export class UnroundedMoney {
  constructor(readonly value: Decimal) {}
  plus(other: UnroundedMoney): UnroundedMoney {
    return new UnroundedMoney(this.value.plus(other.value));
  }
  toString(): string {
    return this.value.toString();
  }
}

export class Money extends Scaled<Money> {
  protected readonly scale = 2;

  private constructor(value: Decimal) {
    super(value);
  }

  protected make(value: Decimal): Money {
    return new Money(value);
  }

  /** Build from a string, integer or Decimal; inputs with more than 2 decimals are rounded half-up. */
  static of(input: DecimalInput): Money {
    return new Money(parse(input, 'Money').toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  }

  static zero(): Money {
    return new Money(new Dec(0));
  }

  /** Exact product with a rate or quantity; call `roundMoney()` where a spec says so. */
  times(factor: Rate | Quantity): UnroundedMoney {
    return new UnroundedMoney(this.value.times(factor.value));
  }

  /** Exact percentage of this amount (percent 18 means 18%). */
  percent(p: Percent): UnroundedMoney {
    return new UnroundedMoney(this.value.times(p.value).div(100));
  }
}

/** Round an exact amount half-up to 2 decimals. */
export function roundMoney(amount: UnroundedMoney | Money): Money {
  return Money.of(amount.value);
}

export class Quantity extends Scaled<Quantity> {
  protected readonly scale = 4;

  private constructor(value: Decimal) {
    super(value);
  }

  protected make(value: Decimal): Quantity {
    return new Quantity(value);
  }

  /** Negative quantities are rejected unless the caller says its spec allows them (BR-4). */
  static of(input: DecimalInput, options: { allowNegative?: boolean } = {}): Quantity {
    const value = parse(input, 'Quantity');
    if (value.decimalPlaces() > 4) {
      throw new ValidationError('quantity_precision', 'Quantity allows at most 4 decimal places');
    }
    if (value.isNegative() && !value.isZero() && options.allowNegative !== true) {
      throw new ValidationError('quantity_negative', 'Quantity must not be negative');
    }
    return new Quantity(value);
  }
}

export class Rate extends Scaled<Rate> {
  protected readonly scale = 4;

  private constructor(value: Decimal) {
    super(value);
  }

  protected make(value: Decimal): Rate {
    return new Rate(value);
  }

  static of(input: DecimalInput): Rate {
    const value = parse(input, 'Rate');
    if (value.decimalPlaces() > 4) {
      throw new ValidationError('rate_precision', 'Rate allows at most 4 decimal places');
    }
    return new Rate(value);
  }
}

export class Percent extends Scaled<Percent> {
  protected readonly scale = 4;

  private constructor(value: Decimal) {
    super(value);
  }

  protected make(value: Decimal): Percent {
    return new Percent(value);
  }

  static of(input: DecimalInput): Percent {
    const value = parse(input, 'Percent');
    if (value.decimalPlaces() > 4) {
      throw new ValidationError('percent_precision', 'Percent allows at most 4 decimal places');
    }
    return new Percent(value);
  }
}
