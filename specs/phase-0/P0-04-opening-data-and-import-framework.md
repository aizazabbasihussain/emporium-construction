---
id: P0-04
title: Opening data templates and import framework
phase: 0
module: importer
status: done
depends_on: [P1-01, P1-02]
requires_inputs: []
---

# P0-04 Opening data templates and import framework

## 1. Purpose
Provide one safe way to load the company's paper-era data (clients, vendors, items, workers, opening balances, stock) from spreadsheets: templates, validation, dry run, all-or-nothing commit and error reports. Each module registers its own importer.

## 2. Boundary
- Owns: tables `imp_*`, `packages/domain/importer`, `apps/api/src/modules/importer`.
- Provides: `registerImporter({code, label, schema, columns, dependsOn, apply})`, template generation, `runDryRun`, `commit`, importer registry listing.
- Consumes: kernel (`audit.record()`, `events.publish()`) and identity (`requirePermission`, `registerPermissions`). Modules register importers in later specs.
- Must not: write to any other module's tables directly; every write goes through the registered importer's `apply` function, which uses its own module's service.
- Out of scope: the individual importers (each owning spec lists its importer), UI beyond the import screen.

## 3. Data model
- `imp_batches(id, importer_code, file_name, file_hash, status, row_count, error_count, dry_run_at, committed_at, created_by, ...base)`; status in `dry_run_ok|dry_run_failed|committed|rolled_back`.
- `imp_errors(batch_id, row_no, column_name, message)`.
- Unique index on `(importer_code, file_hash)` where status = `committed`.

## 4. Business rules
- BR-1 Accepted formats: CSV (UTF-8, BOM tolerated) and XLSX (first sheet). Maximum 10 MB and 50,000 rows.
- BR-2 A commit requires a prior successful dry run of the same file hash by the same user; a commit with any validation error is refused (no partial imports).
- BR-3 The commit runs in a single database transaction; any failure rolls back everything and records status `rolled_back`.
- BR-4 Re-importing a file already committed for the same importer is refused unless `force=true` and the user holds `importer.batch.force`.
- BR-5 Cell cleaning: trim whitespace; preserve Urdu text; empty string to null; dates accepted as ISO `yyyy-mm-dd` or `dd/mm/yyyy` (setting, default both); amounts and quantities must be plain decimals without thousands separators, otherwise a row error.
- BR-6 Validation reports every row error (row number, column, message), not just the first; the error report downloads as CSV.
- BR-7 Importers declare `dependsOn` (importer codes); a batch is refused if a dependency importer has no committed batch.
- BR-8 Templates are generated from the importer's column schema, with header row, one synthetic example row and a notes sheet listing required columns, formats and allowed values.
- BR-9 Every batch and commit writes audit entries and an outbox event `import.committed`.
- BR-10 Files are processed in memory or temp storage and deleted after the dry run or commit; only hash and metadata persist.

## 5. API and UI
- `GET /imports/importers` list; `GET /imports/importers/:code/template?format=csv|xlsx`
- `POST /imports/importers/:code/dry-run` (multipart file) returns batch id, counts, errors
- `POST /imports/batches/:id/commit`; `GET /imports/batches`, `GET /imports/batches/:id/errors.csv`
- Screen: choose importer, download template, upload, view dry-run result, commit.

## 6. Permissions
`importer.batch.run` (admin, accountant), `importer.batch.force` (admin), `importer.batch.read` (admin, accountant, management).

## 7. Test requirements
- T-1 Parser tests: CSV with BOM, quoted commas, Urdu text, empty cells, XLSX first sheet, oversize file, too many rows.
- T-2 Each cleaning rule in BR-5 with accepting and rejecting cases.
- T-3 Dry run collects all errors; a file with 3 faulty rows reports 3 errors.
- T-4 Commit refused without prior dry run, with errors, for a duplicate hash, with an unmet dependency; allowed with force and permission.
- T-5 Transaction rollback: an `apply` that throws leaves no rows and status `rolled_back`.
- T-6 Template generation matches the schema (column order, example row validates).
- T-7 Property test: any generated valid file round-trips through dry run and commit with the same row count.
- T-8 Route contract tests (success, validation failure, permission denied, not found); repository integration tests; 100% coverage of service and domain.

## 8. Acceptance criteria
- AC-1 A sample importer (test-only) can be registered, templated, dry-run and committed end to end.
- AC-2 No partial commits under any failure in T-5.
- AC-3 Error report CSV lists row, column and message for every fault.
- AC-4 Uploaded files are not retained after processing.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
None. H-13 (the actual opening data) is not needed to build the framework; it is needed only to run real imports (P2-10).
