import type { ColumnDef } from '@emporium/domain/importer';
import type { ImportBatchStatus } from '@emporium/shared';
import type { z } from 'zod';
import type { Db } from '../platform/index.js';

export type { Db };

export interface ApplyContext {
  actorUserId: string;
  requestId: string | null;
  batchId: string;
}

/** What a module hands to `registerImporter` (spec P0-04 section 2). */
export interface ImporterDefinition<T = unknown> {
  /** Lowercase code, for example `clients`. */
  code: string;
  label: string;
  /** Row-level validation of the cleaned record; issue paths name the column. */
  schema: z.ZodType<T>;
  /** Template and cell-cleaning definition, in file column order. */
  columns: readonly ColumnDef[];
  /** Importer codes that must have a committed batch first (BR-7). */
  dependsOn?: readonly string[];
  /** Writes the rows through the owning module's service inside the commit transaction. */
  apply(rows: readonly T[], ctx: ApplyContext, tx: Db): Promise<void>;
}

export interface RegisteredImporter {
  code: string;
  label: string;
  schema: z.ZodType;
  columns: readonly ColumnDef[];
  dependsOn: readonly string[];
  apply(rows: readonly unknown[], ctx: ApplyContext, tx: Db): Promise<void>;
}

export interface ImporterSummary {
  code: string;
  label: string;
  dependsOn: string[];
  columns: ColumnDef[];
}

export interface BatchDto {
  id: string;
  importerCode: string;
  fileName: string;
  fileHash: string;
  status: ImportBatchStatus;
  forced: boolean;
  rowCount: number;
  errorCount: number;
  dryRunAt: string | null;
  committedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ErrorDto {
  rowNo: number;
  column: string;
  message: string;
}

export interface DryRunResult {
  batchId: string;
  status: ImportBatchStatus;
  rowCount: number;
  errorCount: number;
  /** The first errors only; the full list is in the CSV report (BR-6). */
  errors: ErrorDto[];
}

export interface Actor {
  userId: string;
  requestId: string | null;
}

export interface FileDownload {
  fileName: string;
  contentType: string;
  body: Buffer | string;
}
