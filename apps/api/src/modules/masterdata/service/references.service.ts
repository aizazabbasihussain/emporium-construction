import { ValidationError } from '@emporium/domain';
import type { ReferenceableEntity } from '@emporium/shared';
import type { CostCodeUsage, Db, IsReferenced } from '../types.js';

export interface References {
  /** BR-8: a module registers, at startup, how to tell whether its documents use a party or item. */
  registerReferenceCheck(entity: ReferenceableEntity, check: IsReferenced): void;
  /** BR-6: the cost ledger registers how to tell whether a cost code has posted costs. */
  registerCostCodeUsage(check: CostCodeUsage): void;
  isReferenced(db: Db, entity: ReferenceableEntity, id: string): Promise<boolean>;
  costCodeUsage: CostCodeUsage;
}

export function createReferences(): References {
  const checks: Record<ReferenceableEntity, IsReferenced[]> = { party: [], item: [] };
  let usage: CostCodeUsage | undefined;
  return {
    registerReferenceCheck(entity, check) {
      checks[entity].push(check);
    },
    registerCostCodeUsage(check) {
      if (usage !== undefined) {
        throw new ValidationError('cost_code_usage_registered', 'A cost code usage check exists');
      }
      usage = check;
    },
    async isReferenced(db, entity, id) {
      for (const check of checks[entity]) {
        if (await check(db, id)) return true;
      }
      return false;
    },
    // Until the cost ledger exists (P1-09) nothing has posted costs.
    costCodeUsage: (db, id) =>
      usage === undefined
        ? Promise.resolve({ postedCosts: false, openBudgetLines: false })
        : usage(db, id),
  };
}
