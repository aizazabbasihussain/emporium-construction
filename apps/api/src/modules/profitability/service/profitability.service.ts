import { ConflictError } from '@emporium/domain';
import { BusinessDate } from '@emporium/domain/kernel';
import {
  alertChanges,
  assertThresholds,
  compareRisk,
  computeFinancials,
  evaluateAlerts,
  pickThresholds,
  type AlertCode,
  type Financials,
} from '@emporium/domain/profitability';
import { en } from '@emporium/shared';
import { toCsv, toXlsx, type Section } from '../../reports/index.js';
import {
  assertFound,
  assertForecastAmount,
  assertMayManageThresholds,
  assertMayRead,
  assertMaySetForecast,
  assertProjectVisible,
  assertScopeMatches,
  assertThresholdFree,
  canSeeProject,
} from '../policy/profitability.policy.js';
import {
  clearAlert,
  findLatestForecast,
  findThreshold,
  findThresholdOfScope,
  insertAlert,
  insertForecast,
  insertThreshold,
  listAlerts,
  listOpenAlertCodes,
  listThresholds,
  softDeleteThreshold,
  updateThreshold,
  type ForecastRow,
  type ThresholdRow,
} from '../repo/profitability.repo.js';
import type {
  Actor,
  AlertDto,
  Db,
  ForecastDto,
  PortfolioDto,
  ProjectFinancialsDto,
  ProjectRef,
  ThresholdDto,
  ThresholdInput,
} from '../types.js';
import type { ProfitabilityDeps } from './context.js';
import { createRecorder } from './support.js';

export type ProfitabilityService = ReturnType<typeof createProfitabilityService>;

const SYSTEM: Actor = {
  userId: 'system',
  roles: ['admin'],
  scopes: [],
  permissions: new Set(),
  requestId: null,
};

const forecastDto = (row: ForecastRow): ForecastDto => ({
  id: row.id,
  projectId: row.project_id,
  costToComplete: row.cost_to_complete,
  note: row.note,
  forecastDate: row.forecast_date,
  setBy: row.set_by,
});

const thresholdDto = (row: ThresholdRow): ThresholdDto => ({
  id: row.id,
  scope: row.scope as ThresholdDto['scope'],
  projectId: row.project_id,
  marginFloorPercent: row.margin_floor_percent,
  overspendPercent: row.overspend_percent,
  receivableAgeDays: row.receivable_age_days,
  active: row.active,
  version: row.version,
});

const refOf = (project: {
  id: string;
  code: string;
  name: string;
  status: string;
  projectManagerId: string | null;
}): ProjectRef => ({
  id: project.id,
  code: project.code,
  name: project.name,
  status: project.status,
  projectManagerId: project.projectManagerId,
});

/** What an export carries: the table and the filters of the header block. */
export interface ExportTables {
  title: string;
  fileStem: string;
  filters: Record<string, string>;
  main: Section;
}

/** A file to send: its type, name and bytes. */
export interface DownloadDto {
  contentType: string;
  fileName: string;
  body: string | Buffer;
}

export function createProfitabilityService(deps: ProfitabilityDeps) {
  const { platform, clock, newId } = deps;
  const record = createRecorder(platform);
  const today = () => BusinessDate.today(clock).toString();

  const dateOf = (asOf: string | undefined): string =>
    asOf === undefined ? today() : BusinessDate.parse(asOf).toString();

  const activeThresholds = async (db: Db): Promise<ThresholdRow[]> => listThresholds(db, true);

  /** Every figure of one project on one date, read from the owning modules (BR-6). */
  async function figuresOf(
    db: Db,
    project: ProjectRef,
    asOf: string,
    thresholdRows: readonly ThresholdRow[],
  ): Promise<ProjectFinancialsDto> {
    const costObject = { type: 'project', id: project.id } as const;
    const [contractValue, cost, billed, collected, aging, vendors, wages, expenses, forecast] =
      await Promise.all([
        deps.variations.getCurrentContractValue(db, project.id, asOf),
        deps.projects.getCostSummary(db, costObject, asOf),
        deps.billing.getProjectBilling(db, project.id, asOf),
        deps.receivables.getProjectCollected(db, project.id, asOf),
        deps.receivables.getProjectAging(db, project.id, asOf),
        deps.payables.getPaidForProject(db, project.id, asOf),
        deps.payroll.getPaidWagesForProject(db, project.id, asOf),
        deps.expenses.getReimbursedForProject(db, project.id, asOf),
        findLatestForecast(db, project.id, asOf),
      ]);
    const financials = computeFinancials({
      contractValue,
      billed,
      collected,
      cost: { ...cost.totals, budget: cost.budget as string },
      paidOut: { vendors, wages, expenses },
      forecast: forecast?.cost_to_complete ?? null,
    });
    const picked = pickThresholds(
      thresholdRows.map((row) => ({ ...row, projectId: row.project_id })),
      project.id,
    );
    const thresholds = picked === null ? null : thresholdDto(picked);
    return {
      ...financials,
      projectId: project.id,
      code: project.code,
      name: project.name,
      status: project.status,
      asOf,
      forecast: forecast === undefined ? null : forecastDto(forecast),
      thresholds,
      alerts: evaluateAlerts({
        financials,
        thresholds:
          thresholds === null
            ? null
            : {
                marginFloorPercent: thresholds.marginFloorPercent,
                overspendPercent: thresholds.overspendPercent,
                receivableAgeDays: thresholds.receivableAgeDays,
              },
        oldestDueDate: aging.oldestDueDate,
        asOf,
      }),
      oldestDueDate: aging.oldestDueDate,
    };
  }

  const visibleProjects = async (db: Db, actor: Actor): Promise<ProjectRef[]> =>
    (await deps.projects.listProjectsForUser(db, actor))
      .map(refOf)
      .filter((project) => canSeeProject(actor, project));

  const money = (key: keyof typeof en.profitability.figures) => en.profitability.figures[key];

  function projectTables(data: ProjectFinancialsDto): ExportTables {
    const row = (
      figure: string,
      amount: string | null,
      percent: string | null = null,
    ): Record<string, string | null> => ({ figure, amount, percent });
    const f: Financials = data;
    return {
      title: en.profitability.title,
      fileStem: `profitability-${data.code}`,
      filters: { project: `${data.code} ${data.name}`, asOf: data.asOf },
      main: {
        totals: null,
        key: 'figures',
        columns: [
          { key: 'figure', type: 'text' },
          { key: 'amount', type: 'money' },
          { key: 'percent', type: 'percent' },
        ],
        rows: [
          row(money('contractValue'), f.contractValue),
          row(money('billedBase'), f.billedBase, f.billedPercent),
          row(money('billedGross'), f.billedGross),
          row(money('collectedGross'), f.collectedGross),
          row(money('collectedBase'), f.collectedBase, f.collectedPercent),
          row(money('withheldTax'), f.withheldTax),
          row(money('outstandingReceivable'), f.outstandingReceivable),
          row(money('committed'), f.committed),
          row(money('approved'), f.approved),
          row(money('posted'), f.posted),
          row(money('costToDate'), f.costToDate, f.costPercentOfBudget),
          row(money('budget'), f.budget),
          row(
            money(
              f.costToCompleteSource === 'forecast' ? 'costToCompleteForecast' : 'costToComplete',
            ),
            f.costToComplete,
          ),
          row(money('expectedMargin'), f.expectedMargin, f.expectedMarginPercent),
          row(money('currentMargin'), f.currentMargin, f.currentMarginPercent),
          row(money('paidOutVendors'), f.paidOutVendors),
          row(money('paidOutWages'), f.paidOutWages),
          row(money('paidOutExpenses'), f.paidOutExpenses),
          row(money('paidOut'), f.paidOut),
          row(money('cashPosition'), f.cashPosition),
        ],
      },
    };
  }

  function portfolioTables(data: PortfolioDto): ExportTables {
    return {
      title: en.profitability.portfolioTitle,
      fileStem: 'profitability-portfolio',
      filters: { asOf: data.asOf },
      main: {
        totals: null,
        key: 'portfolio',
        columns: [
          { key: 'projectCode', type: 'text' },
          { key: 'projectName', type: 'text' },
          { key: 'status', type: 'text' },
          { key: 'contractValue', type: 'money' },
          { key: 'billedPercent', type: 'percent' },
          { key: 'collectedPercent', type: 'percent' },
          { key: 'costPercentOfBudget', type: 'percent' },
          { key: 'expectedMargin', type: 'money' },
          { key: 'expectedMarginPercent', type: 'percent' },
          { key: 'cashPosition', type: 'money' },
          { key: 'alerts', type: 'text' },
        ],
        rows: data.items.map((item) => ({
          projectCode: item.code,
          projectName: item.name,
          status: item.status,
          contractValue: item.contractValue,
          billedPercent: item.billedPercent,
          collectedPercent: item.collectedPercent,
          costPercentOfBudget: item.costPercentOfBudget,
          expectedMargin: item.expectedMargin,
          expectedMarginPercent: item.expectedMarginPercent,
          cashPosition: item.cashPosition,
          alerts: item.alerts.map((code) => en.profitability.alerts[code]).join('; '),
        })),
      },
    };
  }

  const service = {
    /** `getProjectFinancials(projectId, asOf)` (spec section 2): BR-1 to BR-3 and BR-6 for one project. */
    async getProjectFinancials(
      db: Db,
      projectId: string,
      asOf: string | undefined,
      actor: Actor,
    ): Promise<ProjectFinancialsDto> {
      assertMayRead(actor);
      const date = dateOf(asOf);
      const project = refOf(await deps.projects.getProject(db, projectId));
      assertProjectVisible(actor, project);
      return figuresOf(db, project, date, await activeThresholds(db));
    },

    /** `listProjectFinancials(filters)` (spec section 2): the portfolio of BR-5, riskiest first. */
    async listProjectFinancials(
      db: Db,
      filters: { asOf?: string | undefined; status?: string | undefined },
      actor: Actor,
    ): Promise<PortfolioDto> {
      assertMayRead(actor);
      const asOf = dateOf(filters.asOf);
      const thresholdRows = await activeThresholds(db);
      const projects = (await visibleProjects(db, actor)).filter(
        (project) => filters.status === undefined || project.status === filters.status,
      );
      const items = (
        await Promise.all(projects.map((project) => figuresOf(db, project, asOf, thresholdRows)))
      ).map((data) => ({
        projectId: data.projectId,
        code: data.code,
        name: data.name,
        status: data.status,
        contractValue: data.contractValue,
        billedPercent: data.billedPercent,
        collectedPercent: data.collectedPercent,
        costPercentOfBudget: data.costPercentOfBudget,
        expectedMargin: data.expectedMargin,
        expectedMarginPercent: data.expectedMarginPercent,
        cashPosition: data.cashPosition,
        alerts: data.alerts,
      }));
      items.sort(
        (a, b) =>
          compareRisk({ ...a, alerts: a.alerts.length }, { ...b, alerts: b.alerts.length }) ||
          a.code.localeCompare(b.code),
      );
      return { asOf, items };
    },

    /** BR-9: the portfolio or one project as CSV or Excel tables. */
    async exportTables(
      db: Db,
      target: {
        projectId?: string | undefined;
        asOf?: string | undefined;
        status?: string | undefined;
      },
      actor: Actor,
    ): Promise<ExportTables> {
      return target.projectId === undefined
        ? portfolioTables(await service.listProjectFinancials(db, target, actor))
        : projectTables(
            await service.getProjectFinancials(db, target.projectId, target.asOf, actor),
          );
    },

    /** BR-9: the same tables as a CSV or Excel file with the report header block. */
    async download(
      db: Db,
      target: {
        projectId?: string | undefined;
        asOf?: string | undefined;
        status?: string | undefined;
      },
      format: 'csv' | 'xlsx',
      actor: Actor,
    ): Promise<DownloadDto> {
      const tables = await service.exportTables(db, target, actor);
      const meta = {
        title: tables.title,
        filters: tables.filters,
        generatedAt: clock.now(),
        generatedBy: actor.name ?? actor.userId,
      };
      const input = { main: tables.main, extras: [] };
      const stamp = today();
      return format === 'csv'
        ? {
            contentType: 'text/csv; charset=utf-8',
            fileName: `${tables.fileStem}-${stamp}.csv`,
            body: toCsv(input, meta),
          }
        : {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: `${tables.fileStem}-${stamp}.xlsx`,
            body: await toXlsx(input, meta),
          };
    },

    /** `PUT /profitability/projects/:id/forecast`: a new forecast row; the latest one is used. */
    async setForecast(
      projectId: string,
      input: {
        costToComplete: string;
        note?: string | undefined;
        forecastDate?: string | undefined;
      },
      actor: Actor,
      tx: Db,
    ): Promise<ForecastDto> {
      assertMaySetForecast(actor);
      const project = refOf(await deps.projects.getProject(tx, projectId));
      assertProjectVisible(actor, project);
      assertForecastAmount(input.costToComplete);
      const row = await insertForecast(
        tx,
        {
          id: newId(),
          projectId,
          costToComplete: input.costToComplete,
          note: (input.note ?? '').trim(),
          forecastDate: dateOf(input.forecastDate),
          setBy: actor.userId,
        },
        clock.now(),
      );
      await record(tx, actor, {
        action: 'profitability.forecast.set',
        entityType: 'pft_forecast',
        entityId: row.id,
        after: forecastDto(row),
        event: {
          type: 'profitability.forecast.changed',
          payload: { projectId, forecastId: row.id },
        },
      });
      return forecastDto(row);
    },

    async listThresholds(db: Db, actor: Actor): Promise<ThresholdDto[]> {
      assertMayRead(actor);
      return (await listThresholds(db, false)).map(thresholdDto);
    },

    async createThreshold(input: ThresholdInput, actor: Actor, tx: Db): Promise<ThresholdDto> {
      assertMayManageThresholds(actor);
      assertScopeMatches(input.scope, input.projectId);
      assertThresholds(input);
      const projectId = input.projectId ?? null;
      if (projectId !== null) await deps.projects.getProject(tx, projectId);
      assertThresholdFree(await findThresholdOfScope(tx, input.scope, projectId));
      const row = await insertThreshold(
        tx,
        {
          id: newId(),
          scope: input.scope,
          projectId,
          marginFloorPercent: input.marginFloorPercent,
          overspendPercent: input.overspendPercent,
          receivableAgeDays: input.receivableAgeDays,
          active: input.active ?? true,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'profitability.threshold.create',
        entityType: 'pft_threshold',
        entityId: row.id,
        after: thresholdDto(row),
        event: { type: 'profitability.threshold.changed', payload: { thresholdId: row.id } },
      });
      return thresholdDto(row);
    },

    async updateThreshold(
      id: string,
      input: Omit<ThresholdInput, 'scope' | 'projectId'> & { version: number },
      actor: Actor,
      tx: Db,
    ): Promise<ThresholdDto> {
      assertMayManageThresholds(actor);
      assertThresholds(input);
      const before = assertFound(await findThreshold(tx, id), 'threshold');
      const row = await updateThreshold(
        tx,
        id,
        input.version,
        {
          marginFloorPercent: input.marginFloorPercent,
          overspendPercent: input.overspendPercent,
          receivableAgeDays: input.receivableAgeDays,
          active: input.active ?? before.active,
        },
        actor.userId,
        clock.now(),
      );
      if (row === undefined) {
        throw new ConflictError('version_conflict', 'The record was changed by someone else');
      }
      await record(tx, actor, {
        action: 'profitability.threshold.update',
        entityType: 'pft_threshold',
        entityId: id,
        before: thresholdDto(before),
        after: thresholdDto(row),
        event: { type: 'profitability.threshold.changed', payload: { thresholdId: id } },
      });
      return thresholdDto(row);
    },

    async removeThreshold(id: string, version: number, actor: Actor, tx: Db): Promise<void> {
      assertMayManageThresholds(actor);
      const before = assertFound(await findThreshold(tx, id), 'threshold');
      if (!(await softDeleteThreshold(tx, id, version, actor.userId, clock.now()))) {
        throw new ConflictError('version_conflict', 'The record was changed by someone else');
      }
      await record(tx, actor, {
        action: 'profitability.threshold.remove',
        entityType: 'pft_threshold',
        entityId: id,
        before: thresholdDto(before),
        event: { type: 'profitability.threshold.changed', payload: { thresholdId: id } },
      });
    },

    /** The alert list screen: open alerts first, then recently cleared ones, of visible projects. */
    async listAlerts(
      db: Db,
      query: { onlyOpen?: boolean | undefined },
      actor: Actor,
    ): Promise<AlertDto[]> {
      assertMayRead(actor);
      const projects = new Map((await visibleProjects(db, actor)).map((p) => [p.id, p]));
      return (await listAlerts(db, { onlyOpen: query.onlyOpen ?? false, limit: 500 }))
        .filter((row) => projects.has(row.project_id))
        .map((row) => {
          const project = projects.get(row.project_id) as ProjectRef;
          return {
            id: row.id,
            projectId: row.project_id,
            projectCode: project.code,
            projectName: project.name,
            alertCode: row.alert_code as AlertCode,
            raisedAt: row.raised_at,
            clearedAt: row.cleared_at,
          };
        });
    },

    /**
     * BR-4: compares the alert conditions of every active project with the stored state. A condition
     * that became true is raised once and the project manager and management are told; one that is no
     * longer true is cleared. The scheduler runs it inside a transaction.
     */
    async evaluateAlerts(tx: Db): Promise<{ raised: number; cleared: number }> {
      const asOf = today();
      const thresholdRows = await activeThresholds(tx);
      const projects = (await deps.projects.listProjectsForUser(tx, SYSTEM))
        .map(refOf)
        .filter((project) => project.status === 'active');
      const by = { userId: null, requestId: null };
      let raised = 0;
      let cleared = 0;
      for (const project of projects) {
        const data = await figuresOf(tx, project, asOf, thresholdRows);
        const open = (await listOpenAlertCodes(tx, project.id)) as AlertCode[];
        const changes = alertChanges(open, data.alerts);
        for (const code of changes.raise) {
          const id = newId();
          await insertAlert(tx, { id, projectId: project.id, alertCode: code }, clock.now());
          const payload = { projectId: project.id, alertCode: code, alertId: id };
          const text = {
            project: `${project.code} ${project.name}`,
            alert: en.profitability.alerts[code],
          };
          if (project.projectManagerId !== null) {
            await deps.notifications.notify(
              [project.projectManagerId],
              'profitability.alert.raised',
              text,
              tx,
            );
          }
          await deps.notifications.notifyRole('management', 'profitability.alert.raised', text, tx);
          await record(tx, by, {
            action: 'profitability.alert.raise',
            entityType: 'pft_alert',
            entityId: id,
            after: payload,
            event: { type: 'profitability.alert.raised', payload },
          });
          raised += 1;
        }
        for (const code of changes.clear) {
          await clearAlert(tx, project.id, code, clock.now());
          const payload = { projectId: project.id, alertCode: code };
          await record(tx, by, {
            action: 'profitability.alert.clear',
            entityType: 'pft_alert',
            entityId: project.id,
            after: payload,
            event: { type: 'profitability.alert.cleared', payload },
          });
          cleared += 1;
        }
      }
      return { raised, cleared };
    },
  };
  return service;
}
