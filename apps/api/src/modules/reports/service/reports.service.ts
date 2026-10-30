import { ConflictError, ValidationError } from '@emporium/domain';
import { BusinessDate } from '@emporium/domain/kernel';
import { normalizePage, pageOf, sortRows } from '@emporium/domain/reports';
import { EXPORT_ROW_LIMIT, type ReportCode, type ReportFormat } from '@emporium/shared';
import {
  assertExportable,
  assertMayRead,
  assertOwnFilter,
  assertProjectReachable,
  scopedProjectIds,
} from '../policy/reports.policy.js';
import {
  findSavedFilter,
  findSavedFilterByName,
  insertSavedFilter,
  listSavedFilters,
  softDeleteSavedFilter,
  type SavedFilterRow,
} from '../repo/reports.repo.js';
import type {
  Actor,
  Db,
  ReportData,
  ReportPageDto,
  ReportQuery,
  Row,
  SavedFilterDto,
} from '../types.js';
import {
  buildClientMaterial,
  buildDprCompliance,
  buildLabour,
  buildPipeline,
  buildProjectCost,
  buildPurchasing,
  buildStock,
  type BuildInput,
} from './builders.js';
import { createLookups, type ProjectRef, type ReportsDeps } from './context.js';
import { toCsv, toXlsx } from './export.js';
import { createRecorder } from './support.js';

const builders: Record<ReportCode, (input: BuildInput) => Promise<ReportData>> = {
  'project-cost': buildProjectCost,
  stock: buildStock,
  purchasing: buildPurchasing,
  labour: buildLabour,
  'dpr-compliance': buildDprCompliance,
  pipeline: buildPipeline,
  'client-material': buildClientMaterial,
};

/** What a download returns: the file and how to name and type it. */
export interface DownloadDto {
  contentType: string;
  fileName: string;
  body: string | Buffer;
}

export type ReportsService = ReturnType<typeof createReportsService>;

const toSavedFilterDto = (row: SavedFilterRow): SavedFilterDto => ({
  id: row.id,
  reportCode: row.report_code as ReportCode,
  name: row.name,
  filter: row.filter,
  version: row.version,
});

export function createReportsService(deps: ReportsDeps) {
  const { platform, clock, newId } = deps;
  const record = createRecorder(platform);

  /** The report with its full main list: filtered, named and in the order of the default sort. */
  async function build(
    db: Db,
    code: ReportCode,
    query: ReportQuery,
    actor: Actor,
  ): Promise<ReportData> {
    assertMayRead(actor, code);
    const reach = scopedProjectIds(actor);
    assertProjectReachable(reach, query.filters.projectId);
    const projects: ProjectRef[] = (await deps.projects.listProjectsForUser(db, actor)).map(
      (project) => ({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        startDate: project.startDate,
      }),
    );
    const data = await builders[code]({
      deps,
      db,
      actor,
      filters: query.filters,
      reach,
      projects,
      look: createLookups(deps, db, projects),
      today: BusinessDate.today(clock).toString(),
    });
    const given = Object.fromEntries(
      Object.entries(query.filters)
        .filter(([, value]) => value !== undefined && value !== false)
        .map(([key, value]) => [key, String(value)]),
    );
    return { ...data, filters: { ...given, ...data.filters } };
  }

  /** BR-11: sorts the main list on the server; without a sort the report's own order stands. */
  function ordered(data: ReportData, query: ReportQuery): Row[] {
    if (query.sort === undefined) {
      return data.defaultSort === undefined
        ? data.main.rows
        : [...data.main.rows].sort(data.defaultSort);
    }
    if (!data.main.columns.some((column) => column.key === query.sort)) {
      throw new ValidationError('invalid_sort', `The report has no column ${query.sort}`);
    }
    return sortRows(data.main.rows, query.sort, query.direction ?? 'asc');
  }

  return {
    /** `GET /reports/<code>` as JSON: one page of the main list and totals over the whole set. */
    async run(db: Db, code: ReportCode, query: ReportQuery, actor: Actor): Promise<ReportPageDto> {
      const page = normalizePage(query.limit, query.offset);
      const data = await build(db, code, query, actor);
      const paged = pageOf(ordered(data, query), page);
      return {
        code,
        filters: data.filters,
        columns: data.main.columns,
        items: paged.items,
        total: paged.total,
        limit: paged.limit,
        offset: paged.offset,
        totals: data.main.totals,
        extras: data.extras,
      };
    },

    /** BR-10: the whole filtered list as CSV or Excel, refused above the row limit. */
    async download(
      db: Db,
      code: ReportCode,
      query: ReportQuery,
      format: Exclude<ReportFormat, 'json'>,
      actor: Actor,
    ): Promise<DownloadDto> {
      const data = await build(db, code, query, actor);
      const main = { ...data.main, rows: ordered(data, query) };
      assertExportable(
        main.rows.length + data.extras.reduce((sum, section) => sum + section.rows.length, 0),
        EXPORT_ROW_LIMIT,
      );
      const meta = {
        code,
        filters: data.filters,
        generatedAt: clock.now(),
        generatedBy: actor.name ?? actor.userId,
      };
      const input = { main, extras: data.extras };
      const stamp = BusinessDate.today(clock).toString();
      return format === 'csv'
        ? {
            contentType: 'text/csv; charset=utf-8',
            fileName: `${code}-${stamp}.csv`,
            body: toCsv(input, meta),
          }
        : {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: `${code}-${stamp}.xlsx`,
            body: await toXlsx(input, meta),
          };
    },

    /** The saved filters of the caller, of one report or of all. */
    async listFilters(db: Db, actor: Actor, code?: ReportCode): Promise<SavedFilterDto[]> {
      return (await listSavedFilters(db, actor.userId, code ?? null)).map(toSavedFilterDto);
    },

    async saveFilter(
      input: { reportCode: ReportCode; name: string; filter: Record<string, unknown> },
      actor: Actor,
      tx: Db,
    ): Promise<SavedFilterDto> {
      assertMayRead(actor, input.reportCode);
      const name = input.name.trim();
      if (name === '') throw new ValidationError('name_required', 'A name is required');
      if ((await findSavedFilterByName(tx, actor.userId, input.reportCode, name)) !== undefined) {
        throw new ConflictError('saved_filter_exists', 'You already have a filter with this name');
      }
      const row = await insertSavedFilter(
        tx,
        {
          id: newId(),
          userId: actor.userId,
          reportCode: input.reportCode,
          name,
          filter: input.filter,
        },
        clock.now(),
      );
      await record(tx, actor, {
        action: 'reports.filter.save',
        entityType: 'rpt_saved_filter',
        entityId: row.id,
        after: toSavedFilterDto(row),
        event: { type: 'reports.filter.changed', payload: { filterId: row.id, change: 'saved' } },
      });
      return toSavedFilterDto(row);
    },

    async removeFilter(id: string, version: number, actor: Actor, tx: Db): Promise<void> {
      const row = await findSavedFilter(tx, id);
      assertOwnFilter(row, actor.userId);
      if (!(await softDeleteSavedFilter(tx, id, version, actor.userId, clock.now()))) {
        throw new ConflictError('version_conflict', 'The record was changed by someone else');
      }
      await record(tx, actor, {
        action: 'reports.filter.remove',
        entityType: 'rpt_saved_filter',
        entityId: id,
        before: toSavedFilterDto(row),
        event: { type: 'reports.filter.changed', payload: { filterId: id, change: 'removed' } },
      });
    },
  };
}
