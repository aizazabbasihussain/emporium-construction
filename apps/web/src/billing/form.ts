import type { StageEdit } from './api';

const MONEY = /^-?\d{1,14}(\.\d{1,2})?$/;
const POSITIVE_MONEY = /^\d{1,14}(\.\d{1,2})?$/;

/** The first problem of a stage list before it is sent; the API checks the same rules again. */
export function scheduleProblem(
  stages: readonly StageEdit[],
  usedNumbers: readonly number[],
): 'stageNo' | 'name' | 'amount' | 'duplicate' | null {
  const seen = new Set<number>(usedNumbers);
  for (const stage of stages) {
    if (!Number.isInteger(stage.stageNo) || stage.stageNo < 1) return 'stageNo';
    if (stage.name.trim() === '') return 'name';
    if (!MONEY.test(stage.amount.trim()) || Number(stage.amount) === 0) return 'amount';
    if (seen.has(stage.stageNo)) return 'duplicate';
    seen.add(stage.stageNo);
  }
  return null;
}

/** A money amount above zero with at most two decimals. */
export const isPositiveAmount = (value: string): boolean =>
  POSITIVE_MONEY.test(value.trim()) && Number(value) > 0;

/** `optional('  ')` is undefined so a blank field is left out of the request. */
export const optionalAmount = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();
