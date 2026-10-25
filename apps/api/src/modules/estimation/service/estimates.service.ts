import {
  assertEditable,
  assertLockable,
  assertTransition,
  defaultRate,
  estimateTotals,
  instantiateLines,
  isRateMissing,
  lineTotal,
  normalizeDecimal,
  signedLineTotal,
  type CostLine,
  type EstimateStatus,
  type EstimateTerms,
  type TemplateLineSource,
} from '@emporium/domain/estimation';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  estimateLineKinds,
  estimateSectors,
  estimateSuppliers,
  estimateWorkTypes,
  estimationSettingKeys,
  type EstimateLineKind,
  type EstimateSector,
  type EstimateSupplier,
  type EstimateWorkType,
} from '@emporium/shared';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertFound,
  assertKnown,
  assertLockedForBudget,
  assertRevisable,
  assertTemplateActive,
  assertUpdated,
} from '../policy/estimation.policy.js';
import {
  findEstimate,
  findLockedTotals,
  findTemplate,
  insertEstimate,
  listEstimateLines,
  listTemplateLines,
  openRevisionExists,
  replaceEstimateLines,
  searchEstimates,
  softDeleteEstimate,
  updateEstimate,
  type EstimateLineRow,
  type EstimateRow,
  type EstimateSearch,
} from '../repo/estimation.repo.js';
import type {
  Actor,
  Db,
  EstimateCostLineDto,
  EstimateDto,
  EstimateHeaderDto,
  EstimateLineDto,
  EstimateSummaryDto,
  EstimateTotals,
  PageResult,
} from '../types.js';
import { oneOf, prepareLines, quantityOf, rateOf, type LineInput, type Masters } from './lines.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

export interface EstimateLineInput extends LineInput {
  quantity: string;
  rate: string;
  note?: string | null | undefined;
}

export interface EstimateTermsInput {
  overheadPercent?: string | undefined;
  contingencyPercent?: string | undefined;
  targetMarginPercent?: string | undefined;
  proposedPrice?: string | null | undefined;
}

export interface EstimateInput extends EstimateTermsInput {
  title: string;
  workType: string;
  sector: string;
  leadId?: string | null | undefined;
  partyId?: string | null | undefined;
  lines: EstimateLineInput[];
}

export interface FromTemplateInput extends EstimateTermsInput {
  templateId: string;
  title: string;
  sector: string;
  workType?: string | undefined;
  leadId?: string | null | undefined;
  partyId?: string | null | undefined;
  parameterValues: Record<string, string>;
}

export interface PreviewInput extends EstimateTermsInput {
  lines: { lineKind: string; quantity: string; rate: string; suppliedBy?: string | undefined }[];
}

export interface EstimateService {
  list(db: Db, query: EstimateSearch): Promise<PageResult<EstimateHeaderDto>>;
  get(db: Db, id: string): Promise<EstimateDto>;
  create(input: EstimateInput, actor: Actor, tx: Db): Promise<EstimateDto>;
  /** BR-2: lines come from the template's formulas; the user then edits them. */
  createFromTemplate(input: FromTemplateInput, actor: Actor, tx: Db): Promise<EstimateDto>;
  update(
    id: string,
    input: EstimateInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<EstimateDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** BR-8 */
  lock(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<EstimateDto>;
  /** `lockEstimate(id)` of the module interface: locks the current version. */
  lockCurrent(id: string, actor: Actor, tx: Db): Promise<EstimateDto>;
  /** BR-8: a new draft copy of a locked estimate; the old one is superseded when the copy locks. */
  revise(id: string, actor: Actor, tx: Db): Promise<EstimateDto>;
  summary(db: Db, id: string): Promise<EstimateSummaryDto>;
  /** Live totals for lines that are not saved yet (BR-4 to BR-7). */
  preview(
    db: Db,
    input: PreviewInput,
  ): Promise<{ totals: EstimateTotals; rateMissingCount: number }>;
  /** The company's costs of a locked estimate, for the project budget (BR-5). */
  getCostLines(db: Db, id: string): Promise<EstimateCostLineDto[]>;
}

const headerOf = (row: EstimateRow): EstimateHeaderDto => ({
  id: row.id,
  number: row.number,
  revision: row.revision,
  leadId: row.lead_id,
  partyId: row.party_id,
  templateId: row.template_id,
  title: row.title,
  workType: row.work_type as EstimateWorkType,
  sector: row.sector as EstimateSector,
  status: row.status as EstimateStatus,
  parentEstimateId: row.parent_estimate_id,
  parameterValues: row.parameters_values,
  overheadPercent: row.overhead_percent,
  contingencyPercent: row.contingency_percent,
  targetMarginPercent: row.target_margin_percent,
  proposedPrice: row.proposed_price,
  lockedAt: row.locked_at === null ? null : row.locked_at.toISOString(),
  version: row.version,
});

const costLineOf = (line: EstimateLineRow): CostLine => ({
  lineKind: line.line_kind as EstimateLineKind,
  quantity: line.quantity,
  rate: line.rate,
  suppliedBy: line.supplied_by as EstimateSupplier,
});

const lineDtoOf = (line: EstimateLineRow): EstimateLineDto => {
  const cost = costLineOf(line);
  return {
    lineNo: line.line_no,
    description: line.description,
    lineKind: cost.lineKind,
    itemId: line.item_id,
    costCodeId: line.cost_code_id,
    unitCode: line.unit_code,
    quantity: line.quantity,
    rate: line.rate,
    suppliedBy: cost.suppliedBy,
    note: line.note,
    lineTotal: lineTotal(cost),
    rateMissing: isRateMissing(cost),
  };
};

const termsOf = (row: EstimateRow): EstimateTerms => ({
  overheadPercent: row.overhead_percent,
  contingencyPercent: row.contingency_percent,
  targetMarginPercent: row.target_margin_percent,
  proposedPrice: row.proposed_price,
});

export function createEstimateService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masters: Masters;
  masterData: Pick<MasterData, 'getParty'> & {
    costing: Pick<MasterData['costing'], 'searchPrices'>;
  };
}): EstimateService {
  const { platform, clock, newId, masters, masterData } = deps;
  const record = createRecorder(platform);

  const dtoOf = async (db: Db, row: EstimateRow): Promise<EstimateDto> => ({
    ...headerOf(row),
    lines: (await listEstimateLines(db, row.id)).map(lineDtoOf),
  });

  const summaryOf = (row: EstimateRow, lineCount: number) => ({
    number: row.number,
    revision: row.revision,
    status: row.status,
    workType: row.work_type,
    proposedPrice: row.proposed_price,
    lines: lineCount,
  });

  /** The H-15 percentages are typed settings that the estimator may override per estimate. */
  async function resolveTerms(db: Db, input: EstimateTermsInput) {
    const setting = async (key: string, given: string | undefined, field: string, max?: string) =>
      normalizeDecimal(
        given ?? String((await platform.settings.get(db, key)).value),
        field,
        4,
        max,
      );
    const price = textOrNull(input.proposedPrice);
    return {
      overhead_percent: await setting(
        estimationSettingKeys.overheadPercent,
        input.overheadPercent,
        'overhead_percent',
      ),
      contingency_percent: await setting(
        estimationSettingKeys.contingencyPercent,
        input.contingencyPercent,
        'contingency_percent',
      ),
      target_margin_percent: await setting(
        estimationSettingKeys.targetMarginPercent,
        input.targetMarginPercent,
        'target_margin_percent',
        '99.9999',
      ),
      proposed_price: price === null ? null : normalizeDecimal(price, 'proposed_price', 2),
    };
  }

  async function checkHeader(
    db: Db,
    input: { title: string; workType: string; sector: string; partyId?: string | null | undefined },
  ) {
    if (input.partyId !== undefined && input.partyId !== null) {
      assertKnown(
        (await masterData.getParty(db, input.partyId)) !== undefined,
        'unknown_party',
        'The client does not exist',
      );
    }
    return {
      title: requiredText(input.title, 'title'),
      work_type: oneOf(input.workType, estimateWorkTypes, 'work_type'),
      sector: oneOf(input.sector, estimateSectors, 'sector'),
    };
  }

  /** BR-4: quantity and rate are stored with 4 decimals; the line total is derived. */
  async function lineRows(db: Db, workType: string, lines: readonly EstimateLineInput[]) {
    const prepared = await prepareLines(db, masters, workType, lines);
    return prepared.map((line, index) => {
      const source = lines[index] as EstimateLineInput;
      return {
        id: newId(),
        line_no: index + 1,
        description: line.description,
        line_kind: line.lineKind,
        item_id: line.itemId,
        cost_code_id: line.costCodeId,
        unit_code: line.unitCode,
        quantity: quantityOf(source.quantity),
        rate: rateOf(source.rate),
        supplied_by: line.suppliedBy,
        note: textOrNull(source.note),
      };
    });
  }

  async function insertDraft(
    tx: Db,
    actor: Actor,
    values: Record<string, unknown>,
    lines: ({ id: string } & Record<string, unknown>)[],
    change: string,
  ): Promise<EstimateDto> {
    const id = newId();
    const row = await insertEstimate(tx, { id, ...values }, actor.userId, clock.now());
    await replaceEstimateLines(tx, id, lines);
    await record(tx, actor, {
      action: `estimation.estimate.${change}`,
      entityType: 'est_estimate',
      entityId: id,
      after: summaryOf(row, lines.length),
      event: {
        type: 'estimation.estimate.changed',
        payload: { estimateId: id, number: row.number, revision: row.revision, change },
      },
    });
    return dtoOf(tx, row);
  }

  /** BR-3: the latest valid vendor price for the item and unit, else the template default, else zero. */
  async function rateFor(db: Db, line: TemplateLineSource, onDate: string): Promise<string> {
    if (line.itemId === null) return defaultRate([], onDate, line.defaultRate);
    const { items } = await masterData.costing.searchPrices(db, {
      itemId: line.itemId,
      onDate,
      limit: 200,
      offset: 0,
    });
    const candidates = items.filter((price) => price.unitCode === line.unitCode);
    return defaultRate(candidates, onDate, line.defaultRate);
  }

  async function lockRow(tx: Db, row: EstimateRow, expectedVersion: number, actor: Actor) {
    assertTransition(row.status as EstimateStatus, 'locked');
    const lines = await listEstimateLines(tx, row.id);
    assertLockable(lines.map(costLineOf));
    const totals = estimateTotals(lines.map(costLineOf), termsOf(row));
    const now = clock.now();
    const locked = assertUpdated(
      await updateEstimate(
        tx,
        row.id,
        expectedVersion,
        { status: 'locked', locked_totals: JSON.stringify(totals), locked_at: now.toISOString() },
        actor.userId,
        now,
      ),
    );
    if (row.parent_estimate_id !== null) {
      const parent = assertFound(await findEstimate(tx, row.parent_estimate_id, true), 'estimate');
      assertTransition(parent.status as EstimateStatus, 'superseded');
      await updateEstimate(
        tx,
        parent.id,
        parent.version,
        { status: 'superseded' },
        actor.userId,
        now,
      );
      await record(tx, actor, {
        action: 'estimation.estimate.supersede',
        entityType: 'est_estimate',
        entityId: parent.id,
        before: summaryOf(parent, lines.length),
        event: {
          type: 'estimation.estimate.changed',
          payload: {
            estimateId: parent.id,
            number: parent.number,
            revision: parent.revision,
            change: 'superseded',
          },
        },
      });
    }
    await record(tx, actor, {
      action: 'estimation.estimate.lock',
      entityType: 'est_estimate',
      entityId: row.id,
      before: summaryOf(row, lines.length),
      after: { ...summaryOf(locked, lines.length), totals },
      event: {
        type: 'estimate.locked',
        payload: {
          estimateId: row.id,
          number: row.number,
          revision: row.revision,
          supersedesEstimateId: row.parent_estimate_id,
          totals,
        },
      },
    });
    return dtoOf(tx, locked);
  }

  return {
    async list(db, query) {
      const { rows, total } = await searchEstimates(db, query);
      return pageOf(rows.map(headerOf), total, query);
    },

    async get(db, id) {
      return dtoOf(db, assertFound(await findEstimate(db, id), 'estimate'));
    },

    async create(input, actor, tx) {
      const header = await checkHeader(tx, input);
      const terms = await resolveTerms(tx, input);
      const lines = await lineRows(tx, header.work_type, input.lines);
      const number = await platform.numbering.next('estimate', tx);
      return insertDraft(
        tx,
        actor,
        {
          number,
          lead_id: input.leadId ?? null,
          party_id: input.partyId ?? null,
          ...header,
          ...terms,
        },
        lines,
        'create',
      );
    },

    async createFromTemplate(input, actor, tx) {
      const template = assertFound(await findTemplate(tx, input.templateId), 'template');
      assertTemplateActive(template.active);
      const header = await checkHeader(tx, {
        ...input,
        workType: input.workType ?? template.work_type,
      });
      const terms = await resolveTerms(tx, input);
      const today = BusinessDate.today(clock).toString();
      const sources: TemplateLineSource[] = (await listTemplateLines(tx, template.id)).map(
        (line) => ({
          lineNo: line.line_no,
          description: line.description,
          lineKind: line.line_kind as EstimateLineKind,
          itemId: line.item_id,
          costCodeId: line.cost_code_id,
          unitCode: line.unit_code,
          qtyFormula: line.qty_formula,
          defaultRate: line.default_rate,
          suppliedBy: line.supplied_by as EstimateSupplier,
        }),
      );
      const instantiated = instantiateLines(sources, template.parameters, input.parameterValues);
      const inputs: EstimateLineInput[] = [];
      for (const [index, line] of instantiated.entries()) {
        inputs.push({
          ...line,
          rate: await rateFor(tx, sources[index] as TemplateLineSource, today),
          note: null,
        });
      }
      const lines = await lineRows(tx, header.work_type, inputs);
      const number = await platform.numbering.next('estimate', tx);
      return insertDraft(
        tx,
        actor,
        {
          number,
          lead_id: input.leadId ?? null,
          party_id: input.partyId ?? null,
          template_id: template.id,
          parameters_values: JSON.stringify(
            Object.fromEntries(
              template.parameters.map(({ key }) => [key, input.parameterValues[key]]),
            ),
          ),
          ...header,
          ...terms,
        },
        lines,
        'create',
      );
    },

    async update(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findEstimate(tx, id, true), 'estimate');
      assertEditable(existing.status as EstimateStatus);
      const header = await checkHeader(tx, input);
      const terms = await resolveTerms(tx, input);
      const lines = await lineRows(tx, header.work_type, input.lines);
      const before = summaryOf(existing, (await listEstimateLines(tx, id)).length);
      const row = assertUpdated(
        await updateEstimate(
          tx,
          id,
          expectedVersion,
          {
            lead_id: input.leadId ?? null,
            party_id: input.partyId ?? null,
            ...header,
            ...terms,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await replaceEstimateLines(tx, id, lines);
      await record(tx, actor, {
        action: 'estimation.estimate.update',
        entityType: 'est_estimate',
        entityId: id,
        before,
        after: summaryOf(row, lines.length),
        event: {
          type: 'estimation.estimate.changed',
          payload: {
            estimateId: id,
            number: row.number,
            revision: row.revision,
            change: 'updated',
          },
        },
      });
      return dtoOf(tx, row);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findEstimate(tx, id, true), 'estimate');
      assertEditable(existing.status as EstimateStatus);
      assertApplied(await softDeleteEstimate(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'estimation.estimate.delete',
        entityType: 'est_estimate',
        entityId: id,
        before: summaryOf(existing, (await listEstimateLines(tx, id)).length),
        event: {
          type: 'estimation.estimate.changed',
          payload: {
            estimateId: id,
            number: existing.number,
            revision: existing.revision,
            change: 'deleted',
          },
        },
      });
    },

    async lock(id, expectedVersion, actor, tx) {
      const row = assertFound(await findEstimate(tx, id, true), 'estimate');
      return lockRow(tx, row, expectedVersion, actor);
    },

    async lockCurrent(id, actor, tx) {
      const row = assertFound(await findEstimate(tx, id, true), 'estimate');
      return lockRow(tx, row, row.version, actor);
    },

    async revise(id, actor, tx) {
      const source = assertFound(await findEstimate(tx, id, true), 'estimate');
      assertRevisable(source.status as EstimateStatus, await openRevisionExists(tx, id));
      const lines = (await listEstimateLines(tx, id)).map((line) => ({
        id: newId(),
        line_no: line.line_no,
        description: line.description,
        line_kind: line.line_kind,
        item_id: line.item_id,
        cost_code_id: line.cost_code_id,
        unit_code: line.unit_code,
        quantity: line.quantity,
        rate: line.rate,
        supplied_by: line.supplied_by,
        note: line.note,
      }));
      return insertDraft(
        tx,
        actor,
        {
          number: source.number,
          revision: source.revision + 1,
          lead_id: source.lead_id,
          party_id: source.party_id,
          template_id: source.template_id,
          title: source.title,
          work_type: source.work_type,
          sector: source.sector,
          parent_estimate_id: source.id,
          parameters_values: JSON.stringify(source.parameters_values),
          overhead_percent: source.overhead_percent,
          contingency_percent: source.contingency_percent,
          target_margin_percent: source.target_margin_percent,
          proposed_price: source.proposed_price,
        },
        lines,
        'revise',
      );
    },

    async summary(db, id) {
      const row = assertFound(await findEstimate(db, id), 'estimate');
      const estimate = await dtoOf(db, row);
      const rateMissingCount = estimate.lines.filter((line) => line.rateMissing).length;
      const totals =
        row.status === 'draft'
          ? estimateTotals((await listEstimateLines(db, id)).map(costLineOf), termsOf(row))
          : ((await findLockedTotals(db, id)) as EstimateTotals);
      return { estimate, totals, rateMissingCount };
    },

    async preview(db, input) {
      const terms = await resolveTerms(db, input);
      const lines: CostLine[] = input.lines.map((line) => ({
        lineKind: oneOf(line.lineKind, estimateLineKinds, 'line_kind'),
        quantity: quantityOf(line.quantity),
        rate: rateOf(line.rate),
        suppliedBy: oneOf(line.suppliedBy ?? 'company', estimateSuppliers, 'supplied_by'),
      }));
      return {
        totals: estimateTotals(lines, {
          overheadPercent: terms.overhead_percent,
          contingencyPercent: terms.contingency_percent,
          targetMarginPercent: terms.target_margin_percent,
          proposedPrice: terms.proposed_price,
        }),
        rateMissingCount: lines.filter(isRateMissing).length,
      };
    },

    async getCostLines(db, id) {
      const row = assertFound(await findEstimate(db, id), 'estimate');
      assertLockedForBudget(row.status as EstimateStatus);
      return (await listEstimateLines(db, id))
        .filter((line) => line.supplied_by === 'company')
        .map((line) => ({
          lineNo: line.line_no,
          description: line.description,
          lineKind: line.line_kind as EstimateLineKind,
          costCodeId: line.cost_code_id,
          itemId: line.item_id,
          unitCode: line.unit_code,
          quantity: line.quantity,
          rate: line.rate,
          amount: signedLineTotal(costLineOf(line)),
        }));
    },
  };
}
