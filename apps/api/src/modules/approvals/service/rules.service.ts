import { ValidationError } from '@emporium/domain';
import { validateBands, validateSteps } from '@emporium/domain/approvals';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Platform } from '../../platform/index.js';
import {
  deactivateRuleSet,
  insertRule,
  insertStep,
  listActiveRules,
  listDocTypes,
  listStepsOfRules,
} from '../repo/approvals.repo.js';
import type { Db, RuleSetDto, RuleSetInput } from '../types.js';

export interface RulesService {
  listDocTypes(db: Db): Promise<string[]>;
  /** Rule sets of a document type, oldest first; a set applies from its effective date (BR-8). */
  getRules(db: Db, docType: string): Promise<RuleSetDto[]>;
  /**
   * Replaces the rule set that starts on `effectiveFrom` (or adds a new one). Older rows are
   * retired, never deleted, so pending requests keep the rule they were routed by (AC-4).
   */
  replaceRules(
    docType: string,
    input: RuleSetInput,
    actor: { userId: string; requestId: string | null },
    tx: Db,
  ): Promise<RuleSetDto[]>;
}

export function createRulesService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** Codes of the roles that exist; step roles must be among them. */
  roleCodes: (db: Db) => Promise<string[]>;
}): RulesService {
  const { platform, clock, newId } = deps;

  async function getRules(db: Db, docType: string): Promise<RuleSetDto[]> {
    const rules = await listActiveRules(db, docType);
    const steps = await listStepsOfRules(
      db,
      rules.map((r) => r.id),
    );
    const sets = new Map<string, RuleSetDto>();
    for (const rule of rules) {
      const set = sets.get(rule.effective_from) ?? {
        effectiveFrom: rule.effective_from,
        bands: [],
      };
      set.bands.push({
        minAmount: rule.min_amount,
        maxAmount: rule.max_amount,
        steps: steps
          .filter((s) => s.rule_id === rule.id)
          .map((s) => ({
            stepNo: s.step_no,
            roleCode: s.role_code,
            minApprovers: s.min_approvers,
          })),
      });
      sets.set(rule.effective_from, set);
    }
    return [...sets.values()];
  }

  return {
    listDocTypes: (db) => listDocTypes(db),
    getRules,

    async replaceRules(docType, input, actor, tx) {
      BusinessDate.parse(input.effectiveFrom);
      validateBands(input.bands);
      const known = new Set(await deps.roleCodes(tx));
      for (const band of input.bands) {
        validateSteps(band.steps);
        const unknown = band.steps.find((s) => !known.has(s.roleCode));
        if (unknown !== undefined) {
          throw new ValidationError('unknown_role', `Unknown role: ${unknown.roleCode}`, {
            roleCode: unknown.roleCode,
          });
        }
      }
      const before = await getRules(tx, docType);
      const at = clock.now();
      await deactivateRuleSet(tx, {
        docType,
        effectiveFrom: input.effectiveFrom,
        actorUserId: actor.userId,
        at,
      });
      for (const band of input.bands) {
        const id = newId();
        await insertRule(tx, {
          id,
          docType,
          minAmount: band.minAmount,
          maxAmount: band.maxAmount,
          effectiveFrom: input.effectiveFrom,
          actorUserId: actor.userId,
          at,
        });
        for (const step of band.steps) await insertStep(tx, { ruleId: id, ...step });
      }
      const after = await getRules(tx, docType);
      await platform.audit.record(
        {
          actorUserId: actor.userId,
          action: 'approval.rules.replace',
          entityType: 'approval_rules',
          entityId: null,
          before: { docType, sets: before },
          after: { docType, sets: after },
          requestId: actor.requestId,
        },
        tx,
      );
      return after;
    },
  };
}
