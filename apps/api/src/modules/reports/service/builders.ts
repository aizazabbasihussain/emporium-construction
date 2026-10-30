import { workingDates } from '@emporium/domain/attendance';
import { BusinessDate } from '@emporium/domain/kernel';
import {
  compareOverspend,
  costStatus,
  dprCompliance,
  isOverdue,
  ratioPercent,
  sumDecimals,
  totalCostStatus,
  type CostFigures,
} from '@emporium/domain/reports';
import { dprSettingKeys } from '@emporium/shared';
import { listClientMaterialRows } from '../repo/reports.repo.js';
import type { Actor, Db, ReportData, ReportFilters, Row } from '../types.js';
import type { Lookups, ProjectRef, ReportsDeps } from './context.js';

/** What every report builder receives: the caller, the filters and the names it may need. */
export interface BuildInput {
  deps: ReportsDeps;
  db: Db;
  actor: Actor;
  filters: ReportFilters;
  /** The projects the caller reaches (BR-8); undefined for the callers that reach all. */
  reach: readonly string[] | undefined;
  projects: readonly ProjectRef[];
  look: Lookups;
  /** Today in Asia/Karachi. */
  today: string;
}

/** BR-1: budget, committed, approved, posted, used, variance and percent used per cost code. */
export async function buildProjectCost(input: BuildInput): Promise<ReportData> {
  const { deps, db, filters, projects, look } = input;
  const lines: Row[] = [];
  const all: CostFigures[] = [];
  const groups: Row[] = [];
  for (const project of projects) {
    if (filters.projectId !== undefined && project.id !== filters.projectId) continue;
    const summary = await deps.projects.getCostSummary(db, { type: 'project', id: project.id });
    const figures: CostFigures[] = [];
    for (const line of summary.lines) {
      const figure: CostFigures = {
        // A project always has a budget figure (zero when the code has no budget line).
        budget: line.budget as string,
        committed: line.committed,
        approved: line.approved,
        posted: line.posted,
      };
      const code = await look.costCode(line.costCodeId);
      figures.push(figure);
      lines.push({
        projectCode: project.code,
        projectName: project.name,
        costCode: code.code,
        costCodeName: code.name,
        ...costStatus(figure),
      });
    }
    if (figures.length === 0) continue;
    all.push(...figures);
    groups.push({
      projectCode: project.code,
      projectName: project.name,
      ...totalCostStatus(figures),
    });
  }
  const overspend = (a: Row, b: Row) =>
    compareOverspend(
      { variance: a.variance as string, key: `${a.projectCode}|${a.costCode ?? ''}` },
      { variance: b.variance as string, key: `${b.projectCode}|${b.costCode ?? ''}` },
    );
  const money = (key: string) => ({ key, type: 'money' as const });
  const figureColumns = [
    money('budget'),
    money('committed'),
    money('approved'),
    money('posted'),
    money('used'),
    money('variance'),
    { key: 'percentUsed', type: 'percent' as const },
  ];
  return {
    code: 'project-cost',
    filters: {},
    main: {
      key: 'lines',
      columns: [
        { key: 'projectCode', type: 'text' },
        { key: 'projectName', type: 'text' },
        { key: 'costCode', type: 'text' },
        { key: 'costCodeName', type: 'text' },
        ...figureColumns,
      ],
      rows: lines,
      totals: all.length === 0 ? null : { ...totalCostStatus(all) },
    },
    extras: [
      {
        key: 'projects',
        columns: [
          { key: 'projectCode', type: 'text' },
          { key: 'projectName', type: 'text' },
          ...figureColumns,
        ],
        rows: groups.sort(overspend),
        totals: null,
      },
    ],
    defaultSort: overspend,
  };
}

/** BR-2: stock on hand per store and item, company stock valued, and the below-reorder list. */
export async function buildStock(input: BuildInput): Promise<ReportData> {
  const { deps, db, filters, reach, look } = input;
  const scope = { projectIds: reach, storeId: filters.storeId, itemId: filters.itemId };
  const stock = await deps.inventory.listStockWithValue(db, {
    ...scope,
    ownership: filters.ownership,
  });
  const below =
    filters.ownership === 'client' ? [] : await deps.inventory.listBelowReorder(db, scope);
  const belowKeys = new Set(below.map((row) => `${row.storeId}|${row.itemId}`));
  const rows: Row[] = [];
  for (const row of stock) {
    if (
      filters.belowReorderOnly === true &&
      !(row.ownership === 'company' && belowKeys.has(`${row.storeId}|${row.itemId}`))
    ) {
      continue;
    }
    const item = await look.item(row.itemId);
    rows.push({
      storeCode: row.storeCode,
      storeName: row.storeName,
      itemCode: item.code,
      itemName: item.name,
      ownership: row.ownership,
      owner: await look.party(row.ownerPartyId),
      quantity: row.quantity,
      value: row.value,
    });
  }
  const belowRows: Row[] = [];
  for (const row of below) {
    const item = await look.item(row.itemId);
    belowRows.push({
      storeCode: row.storeCode,
      storeName: row.storeName,
      itemCode: item.code,
      itemName: item.name,
      level: row.level,
      quantity: row.quantity,
      shortfall: row.shortfall,
    });
  }
  return {
    code: 'stock',
    filters: {},
    main: {
      key: 'stock',
      columns: [
        { key: 'storeCode', type: 'text' },
        { key: 'storeName', type: 'text' },
        { key: 'itemCode', type: 'text' },
        { key: 'itemName', type: 'text' },
        { key: 'ownership', type: 'text' },
        { key: 'owner', type: 'text' },
        { key: 'quantity', type: 'qty' },
        { key: 'value', type: 'money' },
      ],
      rows,
      totals: { value: sumDecimals(rows.map((row) => row.value as string | null)) },
    },
    extras: [
      {
        key: 'below_reorder',
        columns: [
          { key: 'storeCode', type: 'text' },
          { key: 'storeName', type: 'text' },
          { key: 'itemCode', type: 'text' },
          { key: 'itemName', type: 'text' },
          { key: 'level', type: 'qty' },
          { key: 'quantity', type: 'qty' },
          { key: 'shortfall', type: 'qty' },
        ],
        rows: belowRows,
        totals: null,
      },
    ],
  };
}

/** BR-3: open order lines with ordered, received and outstanding quantity, and open requisitions. */
export async function buildPurchasing(input: BuildInput): Promise<ReportData> {
  const { deps, db, filters, reach, look, today } = input;
  const reaches = (projectId: string | null) =>
    reach === undefined || (projectId !== null && reach.includes(projectId));
  const lines = await deps.procurement.listOpenPoLines(db, {
    vendorId: filters.vendorId,
    projectId: filters.projectId,
    storeId: filters.storeId,
  });
  const rows: Row[] = [];
  for (const line of lines) {
    const overdue = isOverdue(line.expectedDate, today);
    if (!reaches(line.projectId) || (filters.overdueOnly === true && !overdue)) continue;
    const item = await look.item(line.itemId);
    rows.push({
      poNumber: line.poNumber,
      vendor: await look.party(line.vendorId),
      itemCode: item.code,
      itemName: item.name,
      orderedQty: line.orderedQty,
      receivedQty: line.receivedQty,
      openQty: line.openQty,
      expectedDate: line.expectedDate,
      overdue: overdue ? 1 : 0,
      project: look.project(line.projectId),
      storeId: line.storeId,
    });
  }
  const requisitions = (
    await deps.procurement.listOpenRequisitions(db, {
      projectId: filters.projectId,
      storeId: filters.storeId,
      projectIds: reach,
    })
  ).map((requisition): Row => ({
    number: requisition.number,
    project: look.project(requisition.projectId),
    storeId: requisition.storeId,
    requiredBy: requisition.requiredBy,
    status: requisition.status,
    lineCount: requisition.lineCount,
  }));
  return {
    code: 'purchasing',
    filters: {},
    main: {
      key: 'po_lines',
      columns: [
        { key: 'poNumber', type: 'text' },
        { key: 'vendor', type: 'text' },
        { key: 'itemCode', type: 'text' },
        { key: 'itemName', type: 'text' },
        { key: 'orderedQty', type: 'qty' },
        { key: 'receivedQty', type: 'qty' },
        { key: 'openQty', type: 'qty' },
        { key: 'expectedDate', type: 'date' },
        { key: 'overdue', type: 'int' },
        { key: 'project', type: 'text' },
        { key: 'storeId', type: 'text' },
      ],
      rows,
      totals: { overdue: rows.reduce((sum, row) => sum + (row.overdue as number), 0) },
    },
    extras: [
      {
        key: 'requisitions',
        columns: [
          { key: 'number', type: 'text' },
          { key: 'project', type: 'text' },
          { key: 'storeId', type: 'text' },
          { key: 'requiredBy', type: 'date' },
          { key: 'status', type: 'text' },
          { key: 'lineCount', type: 'int' },
        ],
        rows: requisitions,
        totals: null,
      },
    ],
  };
}

/** BR-4: worker-days and labour cost per project and month, and headcount per day. */
export async function buildLabour(input: BuildInput): Promise<ReportData> {
  const { deps, db, filters, reach, look, today } = input;
  const from = filters.from ?? `${today.slice(0, 8)}01`;
  const to = filters.to ?? today;
  const summary = (await deps.attendance.getLabourSummary(db, from, to, filters.projectId)).filter(
    (row) => reach === undefined || reach.includes(row.projectId),
  );
  const rows = summary.map((row): Row => ({
    projectCode: look.project(row.projectId),
    projectName: look.projectName(row.projectId),
    month: row.month,
    workerDays: row.workerDays,
    cost: row.cost,
  }));
  const headcount: Row[] = [];
  for (const projectId of [...new Set(summary.map((row) => row.projectId))]) {
    for (const day of await deps.attendance.getHeadcountSeries(db, projectId, from, to)) {
      headcount.push({
        projectCode: look.project(projectId),
        projectName: look.projectName(projectId),
        date: day.date,
        headcount: day.headcount,
      });
    }
  }
  return {
    code: 'labour',
    filters: { from, to },
    main: {
      key: 'labour',
      columns: [
        { key: 'projectCode', type: 'text' },
        { key: 'projectName', type: 'text' },
        { key: 'month', type: 'text' },
        { key: 'workerDays', type: 'qty' },
        { key: 'cost', type: 'money' },
      ],
      rows,
      totals: {
        workerDays: sumDecimals(
          summary.map((row) => row.workerDays),
          4,
        ),
        cost: sumDecimals(summary.map((row) => row.cost)),
      },
    },
    extras: [
      {
        key: 'headcount',
        columns: [
          { key: 'projectCode', type: 'text' },
          { key: 'projectName', type: 'text' },
          { key: 'date', type: 'date' },
          { key: 'headcount', type: 'int' },
        ],
        rows: headcount,
        totals: null,
      },
    ],
  };
}

/** BR-5: of the days a report was expected, those with a submitted report and those without. */
export async function buildDprCompliance(input: BuildInput): Promise<ReportData> {
  const { deps, db, actor, filters, projects, today } = input;
  const from = filters.from ?? `${today.slice(0, 8)}01`;
  const to = filters.to ?? today;
  const holidays = String(
    (await deps.platform.settings.get(db, dprSettingKeys.siteHolidays)).value,
  );
  const dates = workingDates(from, to, today, holidays);
  const rows: Row[] = [];
  let expected = 0;
  let submitted = 0;
  for (const project of projects) {
    if (project.status !== 'active') continue;
    if (filters.projectId !== undefined && project.id !== filters.projectId) continue;
    const filed = new Set<string>();
    for (let offset = 0; ; offset += 200) {
      const page = await deps.dpr.listDprs(
        db,
        { projectId: project.id, from, to, mine: false, limit: 200, offset },
        actor,
      );
      for (const report of page.items) {
        if (report.status === 'submitted' || report.status === 'reviewed') {
          filed.add(report.reportDate);
        }
      }
      if (offset + 200 >= page.total) break;
    }
    const due = dates.filter((date) => project.startDate === null || date >= project.startDate);
    const result = dprCompliance(due, [...filed]);
    expected += result.expectedDays;
    submitted += result.submittedDays;
    rows.push({
      projectCode: project.code,
      projectName: project.name,
      expectedDays: result.expectedDays,
      submittedDays: result.submittedDays,
      missingDays: result.missingDays,
      percentSubmitted: result.percentSubmitted,
      missingDates: result.missingDates.join(', '),
    });
  }
  return {
    code: 'dpr-compliance',
    filters: { from, to },
    main: {
      key: 'dpr',
      columns: [
        { key: 'projectCode', type: 'text' },
        { key: 'projectName', type: 'text' },
        { key: 'expectedDays', type: 'int' },
        { key: 'submittedDays', type: 'int' },
        { key: 'missingDays', type: 'int' },
        { key: 'percentSubmitted', type: 'percent' },
        { key: 'missingDates', type: 'text' },
      ],
      rows,
      totals: {
        expectedDays: expected,
        submittedDays: submitted,
        missingDays: expected - submitted,
        percentSubmitted: ratioPercent(submitted, expected),
      },
    },
    extras: [],
  };
}

/** BR-6: leads and expected value per stage, conversion per month and overdue follow-ups. */
export async function buildPipeline(input: BuildInput): Promise<ReportData> {
  const { deps, db, filters, today } = input;
  const from = filters.from ?? `${today.slice(0, 4)}-01-01`;
  const to = filters.to ?? today;
  const pipeline = await deps.crm.pipeline(db);
  const conversion = await deps.crm.getConversion(db, { from, to });
  const overdue = await deps.crm.listOverdueFollowUps(db);
  const now = BusinessDate.parse(today);
  return {
    code: 'pipeline',
    filters: { from, to },
    main: {
      key: 'stages',
      columns: [
        { key: 'stageCode', type: 'text' },
        { key: 'stageName', type: 'text' },
        { key: 'kind', type: 'text' },
        { key: 'count', type: 'int' },
        { key: 'expectedValue', type: 'money' },
      ],
      rows: pipeline.stages.map((stage): Row => ({
        stageCode: stage.stageCode,
        stageName: stage.name,
        kind: stage.kind,
        count: stage.count,
        expectedValue: stage.expectedValue,
      })),
      totals: { count: pipeline.totalCount, expectedValue: pipeline.totalExpectedValue },
    },
    extras: [
      {
        key: 'conversion',
        columns: [
          { key: 'month', type: 'text' },
          { key: 'won', type: 'int' },
          { key: 'lost', type: 'int' },
          { key: 'rate', type: 'percent' },
        ],
        rows: conversion.months.map((month): Row => ({ ...month })),
        totals: { won: conversion.won, lost: conversion.lost, rate: conversion.rate },
      },
      {
        key: 'overdue_follow_ups',
        columns: [
          { key: 'leadNumber', type: 'text' },
          { key: 'dueDate', type: 'date' },
          { key: 'daysOverdue', type: 'int' },
          { key: 'assignedTo', type: 'text' },
          { key: 'note', type: 'text' },
        ],
        rows: overdue.map((followUp): Row => ({
          leadNumber: followUp.leadNumber,
          dueDate: followUp.dueDate,
          daysOverdue: now.daysSince(BusinessDate.parse(followUp.dueDate)),
          assignedTo: followUp.assignedTo,
          note: followUp.note,
        })),
        totals: null,
      },
    ],
  };
}

/** BR-7: client material received, used, returned and balance per project and item. */
export async function buildClientMaterial(input: BuildInput): Promise<ReportData> {
  const { db, filters, reach, look } = input;
  const found = await listClientMaterialRows(db, {
    projectId: filters.projectId ?? null,
    projectIds: reach ?? null,
  });
  const rows: Row[] = [];
  for (const row of found) {
    const item = await look.item(row.item_id);
    rows.push({
      projectCode: look.project(row.project_id),
      projectName: look.projectName(row.project_id),
      itemCode: item.code,
      itemName: item.name,
      owner: await look.party(row.owner_party_id),
      received: row.received_qty,
      used: row.used_qty,
      returned: row.returned_qty,
      balance: row.balance_qty,
    });
  }
  return {
    code: 'client-material',
    filters: {},
    main: {
      key: 'client_material',
      columns: [
        { key: 'projectCode', type: 'text' },
        { key: 'projectName', type: 'text' },
        { key: 'itemCode', type: 'text' },
        { key: 'itemName', type: 'text' },
        { key: 'owner', type: 'text' },
        { key: 'received', type: 'qty' },
        { key: 'used', type: 'qty' },
        { key: 'returned', type: 'qty' },
        { key: 'balance', type: 'qty' },
      ],
      rows,
      totals: null,
    },
    extras: [],
  };
}
