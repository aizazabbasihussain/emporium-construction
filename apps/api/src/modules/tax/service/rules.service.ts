import { RuleViolationError } from '@emporium/domain';
import { BusinessDate, Percent, type Clock } from '@emporium/domain/kernel';
import { assertValidRange, checkSuccession, type Closure } from '@emporium/domain/tax';
import {
  taxRuleDocType,
  taxRuleKinds,
  type SupplyKind,
  type TaxRegion,
  type TaxRuleKind,
  type TaxRuleStatus,
  type WithholdingBase,
  type WithholdingDirection,
} from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Platform } from '../../platform/index.js';
import { assertAuthorityKnown, assertRateInRange, deciderOf } from '../policy/tax.policy.js';
import {
  closeRule,
  decideRule,
  findRule,
  insertRegionEntry,
  insertSalesRule,
  insertWithholdingRule,
  listAuthorities,
  listRules,
  listSettings,
  type AnyRuleRow,
  type RegionMapRow,
  type SalesRuleRow,
  type WithholdingRuleRow,
} from '../repo/tax.repo.js';
import type {
  Actor,
  AuthorityDto,
  Db,
  RegionMapDto,
  SalesRuleDto,
  TaxSettingsDto,
  WithholdingRuleDto,
} from '../types.js';
import { createRecorder } from './support.js';

interface RuleInputBase {
  authorityCode: string;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  note?: string | null | undefined;
}

export interface SalesRuleInput extends RuleInputBase {
  supplyKind: SupplyKind;
  nature?: string | null | undefined;
  ratePercent: string;
  taxCode: string;
}

export interface WithholdingRuleInput extends RuleInputBase {
  direction: WithholdingDirection;
  partyType?: string | null | undefined;
  nature: string;
  ratePercent: string;
  base: WithholdingBase;
}

export interface RegionEntryInput extends RuleInputBase {
  region: TaxRegion;
  supplyKind: SupplyKind;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'returned' | 'cancelled';

export interface RulesService {
  authorities(db: Db): Promise<AuthorityDto[]>;
  settings(db: Db): Promise<TaxSettingsDto>;
  listRegionMap(db: Db, status?: TaxRuleStatus): Promise<RegionMapDto[]>;
  listSalesRules(db: Db, status?: TaxRuleStatus): Promise<SalesRuleDto[]>;
  listWithholdingRules(db: Db, status?: TaxRuleStatus): Promise<WithholdingRuleDto[]>;
  /** BR-2, BR-5, BR-6: records a pending rule and asks the owner to approve it. */
  requestSalesRule(input: SalesRuleInput, actor: Actor, tx: Db): Promise<SalesRuleDto>;
  requestWithholdingRule(
    input: WithholdingRuleInput,
    actor: Actor,
    tx: Db,
  ): Promise<WithholdingRuleDto>;
  requestRegionEntry(input: RegionEntryInput, actor: Actor, tx: Db): Promise<RegionMapDto>;
  /** Reacts to `approval.*` events of a rule request; a repeat is a no-op. */
  onApprovalOutcome(
    outcome: ApprovalOutcome,
    payload: { docId: string; requesterId: string },
    tx: Db,
  ): Promise<void>;
}

const regionDto = (row: RegionMapRow): RegionMapDto => ({
  id: row.id,
  region: row.region as TaxRegion,
  supplyKind: row.supply_kind as SupplyKind,
  authorityCode: row.authority_code,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  note: row.note,
  status: row.status as TaxRuleStatus,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
});

const salesDto = (row: SalesRuleRow): SalesRuleDto => ({
  id: row.id,
  authorityCode: row.authority_code,
  supplyKind: row.supply_kind as SupplyKind,
  nature: row.nature,
  ratePercent: row.rate_percent,
  taxCode: row.tax_code,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  note: row.note,
  status: row.status as TaxRuleStatus,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
});

const withholdingDto = (row: WithholdingRuleRow): WithholdingRuleDto => ({
  id: row.id,
  direction: row.direction as WithholdingDirection,
  authorityCode: row.authority_code,
  partyType: row.party_type,
  nature: row.nature,
  ratePercent: row.rate_percent,
  base: row.base as WithholdingBase,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  note: row.note,
  status: row.status as TaxRuleStatus,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
});

const dtoOf = (kind: TaxRuleKind, row: AnyRuleRow) => {
  if (kind === 'region') return regionDto(row as RegionMapRow);
  if (kind === 'sales') return salesDto(row as SalesRuleRow);
  return withholdingDto(row as WithholdingRuleRow);
};

/** Two rules compete for the same dates only when they share this key (BR-2). */
function keyOf(kind: TaxRuleKind, row: AnyRuleRow): string {
  if (kind === 'region') {
    const r = row as RegionMapRow;
    return `${r.region}|${r.supply_kind}`;
  }
  if (kind === 'sales') {
    const r = row as SalesRuleRow;
    return `${r.authority_code}|${r.supply_kind}|${r.nature ?? ''}`;
  }
  const r = row as WithholdingRuleRow;
  return `${r.direction}|${r.authority_code}|${r.party_type ?? ''}|${r.nature}`;
}

const rangeOf = (row: AnyRuleRow) => ({
  id: row.id,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
});

export function createRulesService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): RulesService {
  const { platform, clock, newId, approvals } = deps;
  const record = createRecorder(platform);

  /** BR-2 and BR-5: the closures a rule would cause among the active rules of its key. */
  async function successionOf(db: Db, kind: TaxRuleKind, row: AnyRuleRow) {
    const siblings = (await listRules<AnyRuleRow>(db, kind, 'active')).filter(
      (other) => keyOf(kind, other) === keyOf(kind, row),
    );
    return checkSuccession(rangeOf(row), siblings.map(rangeOf));
  }

  async function validate(db: Db, input: RuleInputBase): Promise<void> {
    assertAuthorityKnown(
      (await listAuthorities(db)).map((authority) => authority.code),
      input.authorityCode,
    );
    BusinessDate.parse(input.effectiveFrom);
    assertValidRange({
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    });
  }

  /** The steps every request shares once its row is stored. */
  async function submit(kind: TaxRuleKind, row: AnyRuleRow, actor: Actor, tx: Db): Promise<void> {
    const { conflict } = await successionOf(tx, kind, row);
    if (conflict !== null) throw new RuleViolationError('tax_rule_overlap', conflict);
    await approvals.requestApproval(
      {
        docType: taxRuleDocType,
        docId: row.id,
        amount: '0',
        requesterId: actor.userId,
        context: { kind, effectiveFrom: row.effective_from },
        requestId: actor.requestId,
      },
      tx,
    );
    await record(tx, actor, {
      action: 'tax.rule.request',
      entityType: `tax_${kind}_rule`,
      entityId: row.id,
      after: dtoOf(kind, row),
      event: { type: 'tax.rule.changed', payload: { kind, ruleId: row.id, status: row.status } },
    });
  }

  const common = (input: RuleInputBase, actor: Actor) => ({
    id: newId(),
    authorityCode: input.authorityCode,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    note: input.note ?? null,
    requestedBy: actor.userId,
    at: clock.now(),
  });

  const rate = (ratePercent: string): string => {
    const parsed = Percent.of(ratePercent);
    assertRateInRange(parsed);
    return parsed.toString();
  };

  async function locate(
    tx: Db,
    id: string,
  ): Promise<{ kind: TaxRuleKind; row: AnyRuleRow } | undefined> {
    for (const kind of taxRuleKinds) {
      const row = await findRule<AnyRuleRow>(tx, kind, id, true);
      if (row !== undefined) return { kind, row };
    }
    return undefined;
  }

  return {
    authorities: async (db) =>
      (await listAuthorities(db)).map((row) => ({
        code: row.code,
        name: row.name,
        registrationType: row.registration_type,
      })),

    async settings(db) {
      const values = new Map((await listSettings(db)).map((row) => [row.key, row.value]));
      return {
        roundingMode: values.get('rounding_mode') === 'per_line' ? 'per_line' : 'per_document',
        pricesIncludeTax: values.get('prices_include_tax') === 'true',
      };
    },

    listRegionMap: async (db, status) =>
      (await listRules<RegionMapRow>(db, 'region', status)).map(regionDto),
    listSalesRules: async (db, status) =>
      (await listRules<SalesRuleRow>(db, 'sales', status)).map(salesDto),
    listWithholdingRules: async (db, status) =>
      (await listRules<WithholdingRuleRow>(db, 'withholding', status)).map(withholdingDto),

    async requestSalesRule(input, actor, tx) {
      await validate(tx, input);
      const row = await insertSalesRule(tx, {
        ...common(input, actor),
        supplyKind: input.supplyKind,
        nature: input.nature ?? null,
        ratePercent: rate(input.ratePercent),
        taxCode: input.taxCode,
      });
      await submit('sales', row, actor, tx);
      return salesDto(row);
    },

    async requestWithholdingRule(input, actor, tx) {
      await validate(tx, input);
      const row = await insertWithholdingRule(tx, {
        ...common(input, actor),
        direction: input.direction,
        partyType: input.partyType ?? null,
        nature: input.nature,
        ratePercent: rate(input.ratePercent),
        base: input.base,
      });
      await submit('withholding', row, actor, tx);
      return withholdingDto(row);
    },

    async requestRegionEntry(input, actor, tx) {
      await validate(tx, input);
      const row = await insertRegionEntry(tx, {
        ...common(input, actor),
        region: input.region,
        supplyKind: input.supplyKind,
      });
      await submit('region', row, actor, tx);
      return regionDto(row);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const found = await locate(tx, payload.docId);
      if (found === undefined || found.row.status !== 'pending_approval') return;
      const { kind, row } = found;
      const decider = deciderOf(
        await approvals.getApprovalState(tx, taxRuleDocType, payload.docId),
      );
      const actor: Actor = { userId: decider ?? payload.requesterId, requestId: null };

      let approved = outcome === 'approved';
      let closures: Closure[] = [];
      if (approved) {
        // Dates may have been taken by another rule since the request was made.
        const plan = await successionOf(tx, kind, row);
        approved = plan.conflict === null;
        closures = plan.closures;
      }
      for (const closure of closures) {
        await closeRule(tx, kind, closure.id, closure.effectiveTo);
      }
      await decideRule(tx, kind, row.id, {
        status: approved ? 'active' : 'rejected',
        approvedBy: approved ? actor.userId : null,
      });
      const after = (await findRule<AnyRuleRow>(tx, kind, row.id)) as AnyRuleRow;
      await record(tx, actor, {
        action: `tax.rule.${approved ? 'activate' : 'reject'}`,
        entityType: `tax_${kind}_rule`,
        entityId: row.id,
        before: dtoOf(kind, row),
        after: { ...dtoOf(kind, after), closed: closures },
        event: {
          type: 'tax.rule.changed',
          payload: { kind, ruleId: row.id, status: after.status },
        },
      });
    },
  };
}
