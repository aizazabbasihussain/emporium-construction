import { ValidationError } from '@emporium/domain';
import {
  assertTemplateFormula,
  assertTemplateParameters,
  evaluateQuantity,
  normalizeDecimal,
  type TemplateParameter,
} from '@emporium/domain/estimation';
import type { Clock } from '@emporium/domain/kernel';
import {
  estimateWorkTypes,
  type EstimateLineKind,
  type EstimateSupplier,
  type EstimateWorkType,
} from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertCodeFree,
  assertFound,
  assertUpdated,
} from '../policy/estimation.policy.js';
import {
  findTemplate,
  insertTemplate,
  listTemplateLines,
  replaceTemplateLines,
  searchTemplates,
  softDeleteTemplate,
  templateCodeTaken,
  updateTemplate,
  type TemplateLineRow,
  type TemplateRow,
  type TemplateSearch,
} from '../repo/estimation.repo.js';
import type {
  Actor,
  Db,
  FormulaPreviewResult,
  PageResult,
  TemplateDto,
  TemplateLineDto,
  TemplateSummaryDto,
} from '../types.js';
import { oneOf, prepareLines, rateOf, type LineInput, type Masters } from './lines.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

export interface TemplateLineInput extends LineInput {
  qtyFormula: string;
  defaultRate?: string | null | undefined;
}

export interface TemplateInput {
  code: string;
  name: string;
  workType: string;
  parameters: TemplateParameter[];
  active?: boolean | undefined;
  lines: TemplateLineInput[];
}

export interface TemplateService {
  list(db: Db, query: TemplateSearch): Promise<PageResult<TemplateSummaryDto>>;
  get(db: Db, id: string): Promise<TemplateDto>;
  create(input: TemplateInput, actor: Actor, tx: Db): Promise<TemplateDto>;
  update(
    id: string,
    input: TemplateInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<TemplateDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** BR-10: templates are versioned by copy; the copy is a new template with its own code. */
  copy(
    id: string,
    input: { code: string; name: string },
    actor: Actor,
    tx: Db,
  ): Promise<TemplateDto>;
  /** T-1 in the screens: shows the quantity each formula gives for sample parameter values. */
  previewFormulas(input: {
    parameters: TemplateParameter[];
    values: Record<string, string>;
    formulas: string[];
  }): FormulaPreviewResult[];
}

const summaryOf = (row: TemplateRow): TemplateSummaryDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  workType: row.work_type as EstimateWorkType,
  active: row.active,
  version: row.version,
});

const lineDtoOf = (row: TemplateLineRow): TemplateLineDto => ({
  lineNo: row.line_no,
  description: row.description,
  lineKind: row.line_kind as EstimateLineKind,
  itemId: row.item_id,
  costCodeId: row.cost_code_id,
  unitCode: row.unit_code,
  qtyFormula: row.qty_formula,
  defaultRate: row.default_rate,
  suppliedBy: row.supplied_by as EstimateSupplier,
});

export function createTemplateService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masters: Masters;
}): TemplateService {
  const { platform, clock, newId, masters } = deps;
  const record = createRecorder(platform);

  const dtoOf = async (db: Db, row: TemplateRow): Promise<TemplateDto> => ({
    ...summaryOf(row),
    parameters: row.parameters,
    lines: (await listTemplateLines(db, row.id)).map(lineDtoOf),
  });

  /** Checks the template as a whole and returns the column values and line rows to store. */
  async function prepare(tx: Db, input: TemplateInput, selfId: string | null) {
    const code = requiredText(input.code, 'code');
    assertCodeFree(await templateCodeTaken(tx, code, selfId));
    const workType = oneOf(input.workType, estimateWorkTypes, 'work_type');
    const parameters = input.parameters.map((parameter) => ({
      key: parameter.key,
      label: requiredText(parameter.label, 'label'),
      unit: parameter.unit.trim(),
    }));
    assertTemplateParameters(parameters);
    const prepared = await prepareLines(tx, masters, workType, input.lines);
    const lines = prepared.map((line, index) => {
      const source = input.lines[index] as TemplateLineInput;
      const qtyFormula = requiredText(source.qtyFormula, 'formula');
      assertTemplateFormula(qtyFormula, parameters);
      const rate = textOrNull(source.defaultRate);
      return {
        id: newId(),
        line_no: index + 1,
        description: line.description,
        line_kind: line.lineKind,
        item_id: line.itemId,
        cost_code_id: line.costCodeId,
        unit_code: line.unitCode,
        qty_formula: qtyFormula,
        default_rate: rate === null ? null : rateOf(rate),
        supplied_by: line.suppliedBy,
      };
    });
    return {
      columns: {
        code,
        name: requiredText(input.name, 'name'),
        work_type: workType,
        parameters: JSON.stringify(parameters),
        active: input.active ?? true,
      },
      lines,
    };
  }

  const summary = (row: TemplateRow, lineCount: number) => ({
    code: row.code,
    workType: row.work_type,
    active: row.active,
    lines: lineCount,
  });

  async function create(input: TemplateInput, actor: Actor, tx: Db): Promise<TemplateDto> {
    const { columns, lines } = await prepare(tx, input, null);
    const id = newId();
    const row = await insertTemplate(tx, { id, ...columns }, actor.userId, clock.now());
    await replaceTemplateLines(tx, id, lines);
    await record(tx, actor, {
      action: 'estimation.template.create',
      entityType: 'est_template',
      entityId: id,
      after: summary(row, lines.length),
      event: {
        type: 'estimation.template.changed',
        payload: { templateId: id, code: row.code, change: 'created' },
      },
    });
    return dtoOf(tx, row);
  }

  return {
    async list(db, query) {
      const { rows, total } = await searchTemplates(db, query);
      return pageOf(rows.map(summaryOf), total, query);
    },

    async get(db, id) {
      return dtoOf(db, assertFound(await findTemplate(db, id), 'template'));
    },

    create,

    async update(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findTemplate(tx, id, true), 'template');
      const before = summary(existing, (await listTemplateLines(tx, id)).length);
      const { columns, lines } = await prepare(tx, input, id);
      const row = assertUpdated(
        await updateTemplate(tx, id, expectedVersion, columns, actor.userId, clock.now()),
      );
      await replaceTemplateLines(tx, id, lines);
      await record(tx, actor, {
        action: 'estimation.template.update',
        entityType: 'est_template',
        entityId: id,
        before,
        after: summary(row, lines.length),
        event: {
          type: 'estimation.template.changed',
          payload: { templateId: id, code: row.code, change: 'updated' },
        },
      });
      return dtoOf(tx, row);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findTemplate(tx, id, true), 'template');
      const before = summary(existing, (await listTemplateLines(tx, id)).length);
      assertApplied(await softDeleteTemplate(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'estimation.template.delete',
        entityType: 'est_template',
        entityId: id,
        before,
        event: {
          type: 'estimation.template.changed',
          payload: { templateId: id, code: existing.code, change: 'deleted' },
        },
      });
    },

    async copy(id, input, actor, tx) {
      const source = assertFound(await findTemplate(tx, id), 'template');
      const lines = await listTemplateLines(tx, id);
      return create(
        {
          code: input.code,
          name: input.name,
          workType: source.work_type,
          parameters: source.parameters,
          lines: lines.map((line) => ({
            description: line.description,
            lineKind: line.line_kind,
            itemId: line.item_id,
            costCodeId: line.cost_code_id,
            unitCode: line.unit_code,
            qtyFormula: line.qty_formula,
            defaultRate: line.default_rate,
            suppliedBy: line.supplied_by,
          })),
        },
        actor,
        tx,
      );
    },

    previewFormulas({ parameters, values, formulas }) {
      assertTemplateParameters(parameters);
      const known = new Map<string, string>();
      for (const { key } of parameters) {
        known.set(
          key,
          normalizeDecimal(Object.hasOwn(values, key) ? (values[key] as string) : '0', key, 4),
        );
      }
      return formulas.map((formula): FormulaPreviewResult => {
        try {
          assertTemplateFormula(formula, parameters);
          const quantity = evaluateQuantity(formula, known);
          return { formula, ok: true, quantity, errorCode: null };
        } catch (error) {
          if (error instanceof ValidationError) {
            return { formula, ok: false, quantity: null, errorCode: error.code };
          }
          throw error;
        }
      });
    },
  };
}
