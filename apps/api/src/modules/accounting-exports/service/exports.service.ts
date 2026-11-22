import { createHash } from 'node:crypto';
import { RuleViolationError } from '@emporium/domain';
import {
  columnTotals,
  controlMismatches,
  dataSection,
  exportLayouts,
  fiscalLabel,
  layoutOf,
  untaggedCount,
  type ExportRow,
} from '@emporium/domain/accounting';
import { filesPermissions } from '@emporium/shared';
import { assertMayRead, assertMayRun, assertPeriod } from '../policy/accounting.policy.js';
import { insertRun, listRuns, listTagsOfDocs, type RunRow } from '../repo/accounting.repo.js';
import type {
  Actor,
  Db,
  ExportCode,
  ExportFilters,
  ExportInfoDto,
  PageResult,
  RunDto,
  RunResultDto,
} from '../types.js';
import type { AccountingDeps } from './context.js';
import { renderCsv, renderXlsx, type Rendered } from './render.js';
import { createRecorder } from './support.js';

export const exportRunEntityType = 'acc_export_run';

export interface ExportsService {
  /** The exports hub: every export with its layout version and columns. */
  list(actor: Actor): ExportInfoDto[];
  /** BR-3 to BR-6, BR-8: builds, checks and stores one export and logs the run. */
  run(code: ExportCode, filters: ExportFilters, actor: Actor, tx: Db): Promise<RunResultDto>;
  /** The history of runs, newest first. */
  runs(
    db: Db,
    query: { exportCode?: ExportCode | undefined; limit: number; offset: number },
    actor: Actor,
  ): Promise<PageResult<RunDto>>;
}

export const runDto = (row: RunRow): RunDto => ({
  id: row.id,
  exportCode: row.export_code as ExportCode,
  schemaVersion: row.schema_version,
  filters: row.filters,
  rowCount: row.row_count,
  checksumSha256: row.checksum_sha256,
  fileId: row.file_id,
  runBy: row.run_by,
  runAt: row.run_at.toISOString(),
});

/** The filters that were set, as text, for the log and the header block. */
const filterRecord = (filters: ExportFilters): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filters).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export function createExportsService(deps: AccountingDeps): ExportsService {
  const { platform, clock, newId, sources, files } = deps;
  const record = createRecorder(platform);

  /** BR-2: the tag of each document row becomes its account_code. */
  async function withAccountCodes(db: Db, rows: readonly ExportRow[]): Promise<ExportRow[]> {
    const idsByType = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.tag === undefined) continue;
      const ids = idsByType.get(row.tag.docType) ?? new Set<string>();
      ids.add(row.tag.docId);
      idsByType.set(row.tag.docType, ids);
    }
    const codes = new Map<string, string>();
    for (const [docType, ids] of idsByType) {
      for (const tag of await listTagsOfDocs(db, docType, [...ids])) {
        codes.set(`${tag.source_doc_type}|${tag.source_doc_id}|${tag.line_ref}`, tag.account_code);
      }
    }
    return rows.map((row) => ({
      ...row,
      values: {
        ...row.values,
        account_code:
          row.tag === undefined
            ? (row.values.account_code ?? null)
            : (codes.get(`${row.tag.docType}|${row.tag.docId}|${row.tag.lineRef}`) ?? null),
      },
    }));
  }

  const service: ExportsService = {
    list(actor) {
      assertMayRead(actor);
      return exportLayouts.map((layout) => ({
        code: layout.code,
        title: layout.title,
        schemaVersion: layout.version,
        columns: layout.columns.map((column) => ({ key: column.key, type: column.type })),
      }));
    },

    async run(code, filters, actor, tx) {
      assertMayRun(actor);
      const layout = layoutOf(code);
      assertPeriod(filters.from, filters.to);
      const fiscalStartMonth = Number(
        (await platform.settings.get(tx, 'accounting.fiscal_year_start_month')).value,
      );
      const loaded = await sources.load(tx, code, filters, { actor, fiscalStartMonth });
      const rows = await withAccountCodes(tx, loaded.rows);
      const totals = columnTotals(layout, rows);
      // BR-5: the sum of the rows must equal what the owning modules report, or nothing is produced.
      const mismatches = controlMismatches(layout, totals, loaded.control);
      if (mismatches.length > 0) {
        throw new RuleViolationError(
          'control_total_mismatch',
          `The export does not tie out to the source modules: ${mismatches
            .map((m) => `${m.column} exported ${m.exported}, source ${m.owning}`)
            .join('; ')}`,
          { mismatches },
        );
      }
      const untagged = untaggedCount(rows);
      const now = clock.now();
      const runId = newId();
      const content: Rendered = {
        layout,
        rows,
        totals,
        header: {
          name: layout.title,
          filters: filterRecord(filters),
          period: `${filters.from} to ${filters.to}`,
          fiscalYear: fiscalLabel(filters.to, fiscalStartMonth),
          schemaVersion: layout.version,
          generatedAt: now,
          generatedBy: actor.name ?? actor.userId,
          warnings: untagged,
        },
      };
      const base = `${code}-${filters.from}-${filters.to}`;
      // The permission to run the export is what allows its files to be stored; the caller needs no
      // separate upload permission (management may run exports but cannot upload files).
      const uploader = {
        ...actor,
        permissions: new Set([...actor.permissions, filesPermissions.upload]),
      };
      const upload = (fileName: string, bytes: Uint8Array) =>
        files.attach(
          { entityType: exportRunEntityType, entityId: runId, fileName, bytes },
          uploader,
          tx,
        );
      const xlsx = await upload(`${base}.xlsx`, await renderXlsx(content));
      const csv = await upload(`${base}.csv`, Buffer.from(renderCsv(content), 'utf8'));
      // BR-6: the checksum covers the data section only, so the same data gives the same checksum.
      const checksum = createHash('sha256').update(dataSection(layout, rows), 'utf8').digest('hex');
      const row = await insertRun(
        tx,
        {
          id: runId,
          exportCode: code,
          schemaVersion: layout.version,
          filters: filterRecord(filters),
          rowCount: rows.length,
          checksum,
          fileId: xlsx.attachment.id,
          by: actor.userId,
        },
        now,
      );
      await record(tx, actor, {
        action: 'accounting.export.run',
        entityType: exportRunEntityType,
        entityId: runId,
        after: { code, filters: filterRecord(filters), rowCount: rows.length, checksum },
        event: { type: 'accounting.export.run', payload: { runId, code, rowCount: rows.length } },
      });
      return {
        run: runDto(row),
        untagged,
        totals,
        files: { xlsx: xlsx.attachment.id, csv: csv.attachment.id },
      };
    },

    async runs(db, query, actor) {
      assertMayRead(actor);
      const { rows, total } = await listRuns(db, query);
      return { items: rows.map(runDto), total, limit: query.limit, offset: query.offset };
    },
  };
  return service;
}
