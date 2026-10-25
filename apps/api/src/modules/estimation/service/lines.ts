import { ValidationError } from '@emporium/domain';
import {
  assertCostCodeKind,
  assertSalvageAllowed,
  normalizeDecimal,
} from '@emporium/domain/estimation';
import {
  estimateLineKinds,
  estimateSuppliers,
  type EstimateLineKind,
  type EstimateSupplier,
} from '@emporium/shared';
import type { MasterData } from '../../masterdata/index.js';
import { assertKnown } from '../policy/estimation.policy.js';
import type { Db } from '../types.js';
import { requiredText } from './support.js';

export type Masters = Pick<MasterData, 'getItem'> & {
  catalog: Pick<MasterData['catalog'], 'listUnits'>;
  costing: Pick<MasterData['costing'], 'listCostCodes'>;
};

export interface LineInput {
  description: string;
  lineKind: string;
  itemId?: string | null | undefined;
  costCodeId: string;
  unitCode: string;
  suppliedBy?: string | undefined;
}

export interface PreparedLine {
  description: string;
  lineKind: EstimateLineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  suppliedBy: EstimateSupplier;
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`invalid_${field}`, `${field} is not valid`);
  }
  return value as T;
}

/**
 * The checks every line shares, for template and estimate lines alike: BR-9 (salvage), BR-11 (cost
 * code kind) and that the cost code, unit and item exist. The reference lists are read once.
 */
export async function prepareLines(
  db: Db,
  masters: Masters,
  workType: string,
  lines: readonly LineInput[],
): Promise<PreparedLine[]> {
  const [costCodes, units] = await Promise.all([
    masters.costing.listCostCodes(db),
    masters.catalog.listUnits(db),
  ]);
  const prepared: PreparedLine[] = [];
  for (const line of lines) {
    const lineKind = oneOf(line.lineKind, estimateLineKinds, 'line_kind');
    assertSalvageAllowed(workType, lineKind);
    const costCode = costCodes.find((code) => code.id === line.costCodeId);
    if (costCode === undefined) throw new ValidationError('unknown_cost_code', 'Unknown cost code');
    assertCostCodeKind(lineKind, costCode.kind);
    assertKnown(
      units.some((unit) => unit.code === line.unitCode),
      'unknown_unit',
      'Unknown unit',
    );
    if (line.itemId !== undefined && line.itemId !== null) {
      assertKnown(
        (await masters.getItem(db, line.itemId)) !== undefined,
        'unknown_item',
        'Unknown item',
      );
    }
    prepared.push({
      description: requiredText(line.description, 'description'),
      lineKind,
      itemId: line.itemId ?? null,
      costCodeId: line.costCodeId,
      unitCode: line.unitCode,
      suppliedBy: oneOf(line.suppliedBy ?? 'company', estimateSuppliers, 'supplied_by'),
    });
  }
  return prepared;
}

export const quantityOf = (text: string): string => normalizeDecimal(text, 'quantity', 4);
export const rateOf = (text: string): string => normalizeDecimal(text, 'rate', 4);
