import { RuleViolationError, ValidationError } from '../errors.js';
import { Money, Percent } from '../kernel/money.js';

export type ScheduleSource = 'quotation' | 'variation' | 'manual';

export interface ScheduleStage {
  stageNo: number;
  name: string;
  basisPercent: string | null;
  amount: string;
  source: ScheduleSource;
  sourceId: string | null;
}

export interface QuotationStageInput {
  stageNo: number;
  name: string;
  basis: 'percent' | 'amount';
  percent: string;
  amount: string;
}

/**
 * BR-1: the schedule of an accepted quotation. A percent stage is that percent of the original
 * contract value (half-up to 2 decimals); an amount stage keeps its amount. The last stage takes any
 * rounding difference so the stages add up to the contract value exactly.
 */
export function scheduleFromQuotation(
  contractValue: string,
  stages: readonly QuotationStageInput[],
): ScheduleStage[] {
  const contract = Money.of(contractValue);
  const result: ScheduleStage[] = stages.map((stage) => ({
    stageNo: stage.stageNo,
    name: stage.name,
    basisPercent: stage.basis === 'percent' ? stage.percent : null,
    amount:
      stage.basis === 'percent'
        ? Money.of(contract.value.times(Percent.of(stage.percent).value).div(100)).toString()
        : Money.of(stage.amount).toString(),
    source: 'quotation',
    sourceId: null,
  }));
  const last = result[result.length - 1];
  if (last !== undefined) {
    const difference = contract.sub(sumOf(result));
    if (!difference.isZero()) last.amount = Money.of(last.amount).add(difference).toString();
  }
  return result;
}

/** BR-1: an approved variation adds one stage with its price impact as the amount. */
export function variationStage(input: {
  stageNo: number;
  number: string;
  priceImpact: string;
  variationId: string;
}): ScheduleStage {
  return {
    stageNo: input.stageNo,
    name: `Variation ${input.number}`,
    basisPercent: null,
    amount: Money.of(input.priceImpact).toString(),
    source: 'variation',
    sourceId: input.variationId,
  };
}

export const nextStageNo = (stages: readonly { stageNo: number }[]): number =>
  stages.reduce((highest, stage) => Math.max(highest, stage.stageNo), 0) + 1;

const sumOf = (stages: readonly { amount: string }[]): Money =>
  stages.reduce((sum, stage) => sum.add(Money.of(stage.amount)), Money.zero());

export const scheduleTotal = (stages: readonly { amount: string }[]): string =>
  sumOf(stages).toString();

/** BR-1: before any invoice is issued the schedule must add up to the current contract value. */
export function assertScheduleMatchesContract(
  stages: readonly { amount: string }[],
  contractValue: string,
): void {
  const total = sumOf(stages);
  const contract = Money.of(contractValue);
  if (!total.equals(contract)) {
    throw new RuleViolationError(
      'schedule_mismatch',
      `The billing schedule adds up to ${total.toString()} but the contract value is ${contract.toString()}`,
    );
  }
}

export interface ScheduleEditStage {
  id?: string | undefined;
  stageNo: number;
  name: string;
  amount: string;
}

export interface PlannedStage extends ScheduleStage {
  id: string;
}

/**
 * BR-1: a manual edit replaces the planned stages. Stages already invoiced are never touched, so a
 * new or renumbered stage cannot reuse their numbers. A stage kept by id keeps its origin; a new one
 * is `manual`.
 */
export function applyScheduleEdit(
  planned: readonly PlannedStage[],
  invoicedStageNos: readonly number[],
  edit: readonly ScheduleEditStage[],
): ScheduleStage[] {
  const seen = new Set<number>(invoicedStageNos);
  return edit.map((stage) => {
    if (!Number.isInteger(stage.stageNo) || stage.stageNo < 1) {
      throw new ValidationError('invalid_stage_no', 'A stage number must be a positive integer');
    }
    if (seen.has(stage.stageNo)) {
      throw new ValidationError(
        'duplicate_stage_no',
        `Stage number ${stage.stageNo} is already used`,
      );
    }
    seen.add(stage.stageNo);
    const name = stage.name.trim();
    if (name === '') throw new ValidationError('stage_name_required', 'A stage needs a name');
    const amount = Money.of(stage.amount);
    if (amount.isZero()) {
      throw new ValidationError('stage_amount_required', 'A stage amount cannot be zero');
    }
    const kept = planned.find((entry) => entry.id === stage.id);
    return {
      stageNo: stage.stageNo,
      name,
      basisPercent:
        kept !== undefined && kept.amount === amount.toString() ? kept.basisPercent : null,
      amount: amount.toString(),
      source: kept?.source ?? 'manual',
      sourceId: kept?.sourceId ?? null,
    };
  });
}
