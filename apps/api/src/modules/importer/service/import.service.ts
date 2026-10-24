import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, RuleViolationError, isDomainError } from '@emporium/domain';
import {
  assertWithinLimits,
  buildTemplate,
  formatOfFileName,
  normalizeDateFormats,
  validateTable,
  type ImportFormat,
  type RowError,
} from '@emporium/domain/importer';
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../../platform/index.js';
import { assertMayForce, assertOwnDryRun } from '../policy/importer.policy.js';
import {
  findBatch,
  hasCommitted,
  hasCommittedHash,
  insertBatch,
  insertErrors,
  listBatches,
  listErrors,
  markCommitted,
  markRolledBack,
  type BatchRow,
} from '../repo/importer.repo.js';
import type {
  Actor,
  BatchDto,
  Db,
  DryRunResult,
  FileDownload,
  ImporterSummary,
  RegisteredImporter,
} from '../types.js';
import { errorsCsv, parseFile, writeTemplate } from './files.service.js';
import type { ImporterRegistry } from './registry.service.js';
import type { StagingStore } from './staging.service.js';

/** How many errors a dry run returns inline; the CSV report carries all of them (BR-6). */
export const INLINE_ERROR_LIMIT = 200;

export interface ImportService {
  listImporters(): ImporterSummary[];
  template(code: string, format: ImportFormat): Promise<FileDownload>;
  dryRun(
    input: { importerCode: string; fileName: string; content: Buffer },
    actor: Actor,
    db: Db,
  ): Promise<DryRunResult>;
  commit(
    batchId: string,
    options: { force: boolean; permissions: ReadonlySet<string> },
    actor: Actor,
    db: Db,
  ): Promise<BatchDto>;
  listBatches(
    db: Db,
    filter: { importerCode?: string | undefined; limit: number; offset: number },
  ): Promise<BatchDto[]>;
  getBatch(db: Db, id: string): Promise<BatchDto>;
  errorsCsv(db: Db, batchId: string): Promise<FileDownload>;
}

export const toBatchDto = (row: BatchRow): BatchDto => ({
  id: row.id,
  importerCode: row.importer_code,
  fileName: row.file_name,
  fileHash: row.file_hash,
  status: row.status,
  forced: row.forced,
  rowCount: row.row_count,
  errorCount: row.error_count,
  dryRunAt: row.dry_run_at?.toISOString() ?? null,
  committedAt: row.committed_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  createdBy: row.created_by,
});

export function createImportService(deps: {
  registry: ImporterRegistry;
  staging: StagingStore;
  platform: Platform;
  clock: Clock;
  newId: () => string;
}): ImportService {
  const { registry, staging, platform, clock } = deps;

  /** BR-7: every importer this one depends on needs a committed batch. */
  async function assertDependencies(db: Db, importer: RegisteredImporter): Promise<void> {
    for (const code of importer.dependsOn) {
      if (!(await hasCommitted(db, code))) {
        throw new RuleViolationError(
          'dependency_not_committed',
          `Import ${code} first: ${importer.code} depends on it`,
          { dependsOn: code },
        );
      }
    }
  }

  async function loadBatch(db: Db, id: string): Promise<BatchRow> {
    const row = await findBatch(db, id);
    if (!row) throw new NotFoundError('batch_not_found', 'Import batch not found');
    return row;
  }

  /** Validates the file against the importer; returns every error and the rows of a clean file. */
  async function validate(
    db: Db,
    importer: RegisteredImporter,
    format: ImportFormat,
    content: Buffer,
  ): Promise<{ errors: RowError[]; rows: unknown[]; rowCount: number }> {
    const table = await parseFile(format, content);
    assertWithinLimits(content.length, Math.max(table.length - 1, 0));
    const setting = await platform.settings.get(db, 'import_date_formats');
    const checked = validateTable(importer.columns, table, normalizeDateFormats(setting.value));
    const errors = [...checked.errors];
    const rows: unknown[] = [];
    const headerOk = errors.length === 0;
    if (headerOk && checked.records.length === 0) {
      errors.push({ rowNo: 1, column: '(file)', message: 'The file has no data rows' });
    }
    const cellFaults = new Set(errors.map((e) => e.rowNo));
    for (const { rowNo, record } of checked.records) {
      if (cellFaults.has(rowNo)) continue;
      const parsed = importer.schema.safeParse(record);
      if (parsed.success) rows.push(parsed.data);
      else {
        for (const issue of parsed.error.issues) {
          const named = String(issue.path[0] ?? '');
          const column = importer.columns.some((c) => c.name === named) ? named : '(row)';
          errors.push({ rowNo, column, message: issue.message });
        }
      }
    }
    errors.sort((a, b) => a.rowNo - b.rowNo);
    return { errors, rows, rowCount: checked.records.length };
  }

  return {
    listImporters: () => registry.list(),

    async template(code, format) {
      const importer = registry.get(code);
      const file = await writeTemplate(buildTemplate(importer.columns), format);
      return { fileName: `${code}-template.${format}`, ...file };
    },

    async dryRun({ importerCode, fileName, content }, actor, db) {
      const importer = registry.get(importerCode);
      const format = formatOfFileName(fileName);
      assertWithinLimits(content.length, null);
      await assertDependencies(db, importer);
      const fileHash = createHash('sha256').update(content).digest('hex');
      const { errors, rows, rowCount } = await validate(db, importer, format, content);
      const status = errors.length === 0 ? 'dry_run_ok' : 'dry_run_failed';
      const batchId = deps.newId();
      await db.transaction(async (tx) => {
        await insertBatch(tx, {
          id: batchId,
          importerCode,
          fileName,
          fileHash,
          status,
          rowCount,
          errorCount: errors.length,
          dryRunAt: clock.now(),
          actorUserId: actor.userId,
        });
        await insertErrors(tx, batchId, errors);
        await platform.audit.record(
          {
            actorUserId: actor.userId,
            action: 'import.dry_run',
            entityType: 'import_batch',
            entityId: batchId,
            after: {
              importerCode,
              fileName,
              fileHash,
              status,
              rowCount,
              errorCount: errors.length,
            },
            requestId: actor.requestId,
          },
          tx,
        );
      });
      if (status === 'dry_run_ok') staging.put(batchId, rows);
      return {
        batchId,
        status,
        rowCount,
        errorCount: errors.length,
        errors: errors.slice(0, INLINE_ERROR_LIMIT),
      };
    },

    async commit(batchId, { force, permissions }, actor, db) {
      const batch = await loadBatch(db, batchId);
      assertOwnDryRun(batch.created_by, actor.userId);
      assertMayForce(permissions, force);
      if (batch.status === 'dry_run_failed') {
        throw new RuleViolationError(
          'dry_run_failed',
          'The dry run found errors; fix the file and run it again',
          { errorCount: batch.error_count },
        );
      }
      if (batch.status !== 'dry_run_ok') {
        throw new RuleViolationError(
          'batch_not_ready',
          `This batch is already ${batch.status.replace('_', ' ')}`,
        );
      }
      const importer = registry.get(batch.importer_code);
      if (!force && (await hasCommittedHash(db, batch.importer_code, batch.file_hash))) {
        throw new ConflictError(
          'duplicate_file',
          'This file was already imported; re-importing needs force',
        );
      }
      await assertDependencies(db, importer);
      const rows = staging.take(batchId);
      if (rows === undefined) {
        throw new RuleViolationError(
          'dry_run_expired',
          'The dry run result is no longer available; run the dry run again',
        );
      }

      try {
        await db.transaction(async (tx) => {
          await importer.apply(
            rows,
            { actorUserId: actor.userId, requestId: actor.requestId, batchId },
            tx,
          );
          const at = clock.now();
          if (
            !(await markCommitted(tx, batchId, { forced: force, at, actorUserId: actor.userId }))
          ) {
            throw new ConflictError('batch_not_ready', 'This batch was already committed');
          }
          await platform.audit.record(
            {
              actorUserId: actor.userId,
              action: 'import.commit',
              entityType: 'import_batch',
              entityId: batchId,
              after: { importerCode: importer.code, rowCount: batch.row_count, forced: force },
              requestId: actor.requestId,
            },
            tx,
          );
          await platform.events.publish(
            {
              type: 'import.committed',
              payload: { batchId, importerCode: importer.code, rowCount: batch.row_count },
            },
            tx,
          );
        });
      } catch (error) {
        // BR-3: the transaction above has rolled back everything the importer wrote.
        staging.discard(batchId);
        await db.transaction(async (tx) => {
          await markRolledBack(tx, batchId, { at: clock.now(), actorUserId: actor.userId });
          await platform.audit.record(
            {
              actorUserId: actor.userId,
              action: 'import.commit_failed',
              entityType: 'import_batch',
              entityId: batchId,
              after: { importerCode: importer.code, reason: reasonOf(error) },
              requestId: actor.requestId,
            },
            tx,
          );
        });
        if (isDomainError(error)) throw error;
        throw new RuleViolationError(
          'import_failed',
          'The import failed and was rolled back; nothing was saved',
        );
      }
      staging.discard(batchId);
      return toBatchDto(await loadBatch(db, batchId));
    },

    async listBatches(db, filter) {
      return (await listBatches(db, filter)).map(toBatchDto);
    },

    async getBatch(db, id) {
      return toBatchDto(await loadBatch(db, id));
    },

    async errorsCsv(db, batchId) {
      const batch = await loadBatch(db, batchId);
      return {
        fileName: `${batch.importer_code}-errors-${batch.id}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: errorsCsv(await listErrors(db, batchId)),
      };
    },
  };
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';
