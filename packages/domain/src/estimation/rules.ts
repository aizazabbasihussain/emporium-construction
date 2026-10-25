import { RuleViolationError, ValidationError } from '../errors.js';
import { isRateMissing, type CostLine, type LineKind } from './costing.js';
import { formulaFunctions, formulaParameters, parseFormula } from './formula.js';

export const estimateStatuses = ['draft', 'locked', 'superseded'] as const;
export type EstimateStatus = (typeof estimateStatuses)[number];

/** Constitution 5.8: the allowed transitions as an explicit table. */
export const estimateTransitions: Record<EstimateStatus, readonly EstimateStatus[]> = {
  draft: ['locked'],
  locked: ['superseded'],
  superseded: [],
};

export function assertTransition(from: EstimateStatus, to: EstimateStatus): void {
  if (!estimateTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'estimate_transition',
      `An estimate cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-8: only a draft can be edited. */
export function assertEditable(status: EstimateStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('estimate_locked', 'A locked estimate is read-only');
  }
}

const SALVAGE_WORK_TYPES: readonly string[] = ['demolition', 'restructure'];

/** BR-9 */
export function assertSalvageAllowed(workType: string, lineKind: LineKind): void {
  if (lineKind === 'salvage_credit' && !SALVAGE_WORK_TYPES.includes(workType)) {
    throw new ValidationError(
      'salvage_not_allowed',
      'Salvage credits are allowed only for demolition and restructure work',
    );
  }
}

const COST_CODE_KINDS: Record<LineKind, readonly string[]> = {
  material: ['material'],
  labour: ['labour'],
  subcontract: ['subcontract'],
  equipment: ['equipment'],
  disposal: ['overhead', 'subcontract'],
  salvage_credit: ['overhead', 'subcontract'],
};

/** BR-11 */
export function assertCostCodeKind(lineKind: LineKind, costCodeKind: string): void {
  if (!COST_CODE_KINDS[lineKind].includes(costCodeKind)) {
    throw new ValidationError(
      'cost_code_kind_mismatch',
      `A ${lineKind} line needs a cost code of kind ${COST_CODE_KINDS[lineKind].join(' or ')}`,
    );
  }
}

/** BR-3: a draft with a company line that has no rate cannot be locked. */
export function assertLockable(lines: readonly Pick<CostLine, 'rate' | 'suppliedBy'>[]): void {
  const missing = lines.filter(isRateMissing).length;
  if (missing > 0) {
    throw new RuleViolationError('rate_missing', `${missing} line(s) have no rate`, { missing });
  }
}

export interface TemplateParameter {
  key: string;
  label: string;
  unit: string;
}

const PARAMETER_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** Parameter keys are lower-case names that cannot be mistaken for a function. */
export function assertTemplateParameters(parameters: readonly TemplateParameter[]): void {
  const seen = new Set<string>();
  for (const { key } of parameters) {
    if (!PARAMETER_KEY.test(key) || (formulaFunctions as readonly string[]).includes(key)) {
      throw new ValidationError('invalid_parameter_key', `Parameter key ${key} is not valid`);
    }
    if (seen.has(key)) {
      throw new ValidationError('duplicate_parameter_key', `Parameter key ${key} is used twice`);
    }
    seen.add(key);
  }
}

/** A saved template formula must parse and may use only the template's own parameters. */
export function assertTemplateFormula(
  formula: string,
  parameters: readonly TemplateParameter[],
): void {
  const known = new Set(parameters.map((parameter) => parameter.key));
  for (const name of formulaParameters(parseFormula(formula))) {
    if (!known.has(name)) {
      throw new ValidationError('formula_unknown_identifier', `Unknown parameter ${name}`);
    }
  }
}
