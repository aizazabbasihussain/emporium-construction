import { ConflictError, DomainError, NotFoundError, ValidationError } from '@emporium/domain';
import { MAX_DATA_ROWS, MAX_FILE_BYTES, parseCsv } from '@emporium/domain/importer';
import { importerPermissions } from '@emporium/shared';
import ExcelJS from 'exceljs';
import fc from 'fast-check';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  createImporterKit,
  peopleCsv,
  resetImporter,
  type ImporterKit,
} from '../test-support.js';
import { INLINE_ERROR_LIMIT, toBatchDto } from './import.service.js';

let k: ImporterKit;

beforeAll(async () => {
  k = await createImporterKit();
  k.registerPeople();
}, 60_000);

afterAll(async () => {
  await k.close();
});

const actor = (userId = ACCOUNTANT) => ({ userId, requestId: 'req-1' });
const runOnly = new Set<string>([importerPermissions.batchRun]);
const runAndForce = new Set<string>([importerPermissions.batchRun, importerPermissions.batchForce]);
const good = peopleCsv(
  'Ali,100.50,2026-01-01,private',
  'Sara,20,05/02/2026,government',
  'Omar,0,,',
);

const dryRun = (
  content: string | Buffer,
  fileName = 'people.csv',
  code = 'people',
  user = ACCOUNTANT,
) =>
  k.importer.service.dryRun(
    { importerCode: code, fileName, content: Buffer.from(content) },
    actor(user),
    k.db,
  );

const commit = (batchId: string, force = false, permissions = runAndForce, user = ACCOUNTANT) =>
  k.importer.service.commit(batchId, { force, permissions }, actor(user), k.db);

const countPeople = async () =>
  Number((await k.db.query<{ n: string }>('select count(*) as n from tst_people'))[0]?.n);

const batchStatus = async (id: string) =>
  (await k.db.query<{ status: string }>('select status from imp_batches where id = $1', [id]))[0]
    ?.status;

beforeEach(async () => {
  await resetImporter(k);
});

describe('registration', () => {
  it('registers the sample importer and lists it with its columns (AC-1)', () => {
    expect(k.importer.service.listImporters()).toMatchObject([
      { code: 'people', label: 'People (test)', dependsOn: [] },
    ]);
    expect(k.importer.registry.get('people').columns).toHaveLength(4);
  });

  it('rejects malformed, duplicate and self-dependent definitions', () => {
    const base = {
      schema: z.object({}),
      columns: [{ name: 'A', type: 'text' as const, required: true, example: 'x' }],
      apply: () => Promise.resolve(),
    };
    const reg = (over: object) => () =>
      k.importer.registerImporter({ code: 'other', label: 'Other', ...base, ...over });
    expect(reg({ code: 'Bad Code' })).toThrow(/code must be/);
    expect(reg({ label: ' ' })).toThrow(/label is required/);
    expect(reg({ columns: [] })).toThrow(/at least one column/);
    expect(
      reg({
        columns: [
          { name: 'A', type: 'text', required: true, example: 'x' },
          { name: ' a ', type: 'text', required: true, example: 'x' },
        ],
      }),
    ).toThrow(/unique/);
    expect(reg({ columns: [{ name: ' ', type: 'text', required: true, example: 'x' }] })).toThrow(
      /non-empty/,
    );
    expect(reg({ dependsOn: ['other'] })).toThrow(/depend on itself/);
    expect(reg({ code: 'people' })).toThrow(/already registered/);
    expect(() => k.importer.registry.get('nope')).toThrow(NotFoundError);
  });
});

describe('templates (BR-8, T-6)', () => {
  it('builds a CSV template matching the columns, with a BOM and an example that validates', async () => {
    const file = await k.importer.service.template('people', 'csv');
    expect(file.fileName).toBe('people-template.csv');
    expect(file.contentType).toContain('text/csv');
    const text = String(file.body);
    expect(text.startsWith('﻿')).toBe(true);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(['Name', 'Amount', 'Joined', 'Kind']);
    expect(rows).toHaveLength(2);
    const result = await dryRun(Buffer.from(file.body as string));
    expect(result.status).toBe('dry_run_ok');
    expect(result.rowCount).toBe(1);
  });

  it('builds an XLSX template with Template and Notes sheets whose example validates', async () => {
    const file = await k.importer.service.template('people', 'xlsx');
    expect(file.fileName).toBe('people-template.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Template', 'Notes']);
    expect(workbook.worksheets[0]?.getRow(1).values).toEqual([
      undefined,
      'Name',
      'Amount',
      'Joined',
      'Kind',
    ]);
    const notes = workbook.worksheets[1];
    expect(notes?.getRow(1).getCell(1).value).toBe('Column');
    expect(notes?.getRow(2).getCell(2).value).toBe('yes');
    expect(notes?.rowCount).toBe(5);
    const result = await dryRun(file.body, 'people.xlsx');
    expect(result).toMatchObject({ status: 'dry_run_ok', rowCount: 1 });
  });

  it('answers 404 for an unknown importer', async () => {
    await expect(k.importer.service.template('nope', 'csv')).rejects.toThrow(NotFoundError);
  });
});

describe('dry run (BR-1, BR-5, BR-6, T-3)', () => {
  it('accepts a clean file and stores only the hash and counts (AC-4)', async () => {
    const result = await dryRun(good);
    expect(result).toMatchObject({ status: 'dry_run_ok', rowCount: 3, errorCount: 0, errors: [] });
    const [row] = await k.db.query<Record<string, unknown>>('select * from imp_batches');
    expect(row).toMatchObject({
      importer_code: 'people',
      file_name: 'people.csv',
      status: 'dry_run_ok',
      row_count: 3,
      error_count: 0,
      created_by: ACCOUNTANT,
    });
    expect(String(row?.file_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(await countPeople()).toBe(0);
    expect(JSON.stringify(row)).not.toContain('Ali');
  });

  it('reports every faulty row: a file with 3 faulty rows reports 3 errors', async () => {
    const result = await dryRun(
      peopleCsv('Ali,1,2026-01-01,', ',5,,', 'Sara,1,,', 'Omar,1,,', 'Zed,abc,,', 'Kim,-5,,'),
    );
    expect(result.status).toBe('dry_run_failed');
    expect(result.errors.map((e) => [e.rowNo, e.column])).toEqual([
      [3, 'Name'],
      [6, 'Amount'],
      [7, 'Amount'],
    ]);
    expect(result.errors[2]?.message).toBe('Must not be negative');
    expect(result.errorCount).toBe(3);
    expect(await batchStatus(result.batchId)).toBe('dry_run_failed');
    expect(await k.db.query('select * from imp_errors')).toHaveLength(3);
    expect(k.importer.staging.take(result.batchId)).toBeUndefined();
  });

  it('names (row) when a schema issue is not tied to a column', async () => {
    k.importer.registerImporter({
      code: 'whole_row',
      label: 'Whole row',
      schema: z.object({ A: z.string() }).refine(() => false, 'Row rejected'),
      columns: [{ name: 'A', type: 'text', required: true, example: 'x' }],
      apply: () => Promise.resolve(),
    });
    const result = await dryRun('A\nx\n', 'w.csv', 'whole_row');
    expect(result.errors).toEqual([{ rowNo: 2, column: '(row)', message: 'Row rejected' }]);
  });

  it('reports header faults, an empty file and a header-only file as errors', async () => {
    expect((await dryRun('Name,Extra\nA,1\n')).errors.map((e) => e.message)).toEqual([
      'Unknown column',
      'Required column is missing',
    ]);
    expect((await dryRun('')).status).toBe('dry_run_failed');
    const headerOnly = await dryRun('Name,Amount\n');
    expect(headerOnly.errors).toEqual([
      { rowNo: 1, column: '(file)', message: 'The file has no data rows' },
    ]);
  });

  it('returns at most 200 errors inline but stores them all (BR-6)', async () => {
    const rows = Array.from({ length: INLINE_ERROR_LIMIT + 50 }, () => 'A,bad,,');
    const result = await dryRun(peopleCsv(...rows));
    expect(result.errorCount).toBe(INLINE_ERROR_LIMIT + 50);
    expect(result.errors).toHaveLength(INLINE_ERROR_LIMIT);
    const csv = await k.importer.service.errorsCsv(k.db, result.batchId);
    expect(parseCsv(String(csv.body))).toHaveLength(INLINE_ERROR_LIMIT + 51);
  });

  it('honours the date format setting', async () => {
    await k.db.query(
      `insert into sys_settings (key, value, description, version) values ('import_date_formats', '"iso"'::jsonb, 'd', 1)`,
    );
    try {
      const result = await dryRun(peopleCsv('A,1,05/02/2026,'));
      expect(result.errors[0]?.message).toBe('Must be a date as yyyy-mm-dd');
    } finally {
      await k.db.query(`delete from sys_settings where key = 'import_date_formats'`);
    }
  });

  it('reads the first sheet of an XLSX file including dates, numbers and formulas', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('First');
    sheet.addRow(['Name', 'Amount', 'Joined', 'Kind']);
    sheet.addRow(['علی', 1250.5, new Date(Date.UTC(2026, 0, 15)), 'Private']);
    sheet.addRow([{ richText: [{ text: 'Sa' }, { text: 'ra' }] }, { formula: '1+1', result: 2 }]);
    sheet.getRow(5).values = ['Late', 7];
    workbook.addWorksheet('Second').addRow(['ignored']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await dryRun(buffer, 'people.XLSX');
    expect(result).toMatchObject({ status: 'dry_run_ok', rowCount: 3 });
    await commit(result.batchId);
    const rows = await k.db.query<{ name: string; amount: string; joined: Date | null }>(
      'select name, amount, joined from tst_people order by name',
    );
    expect(rows.map((r) => r.name)).toEqual(['Late', 'Sara', 'علی']);
    expect(rows[2]?.amount).toBe('1250.50');
  });

  it('rejects an unreadable workbook, a bad extension, oversize and too many rows (T-1)', async () => {
    await expect(dryRun('not a zip', 'people.xlsx')).rejects.toMatchObject({
      code: 'xlsx_unreadable',
    });
    await expect(dryRun('x', 'people.pdf')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(dryRun(Buffer.alloc(MAX_FILE_BYTES + 1), 'big.csv')).rejects.toMatchObject({
      code: 'file_too_large',
    });
    const many = peopleCsv(...Array.from({ length: MAX_DATA_ROWS + 1 }, () => 'A,1,,'));
    await expect(dryRun(many)).rejects.toMatchObject({ code: 'too_many_rows' });
    await expect(dryRun('Name\n"open')).rejects.toBeInstanceOf(ValidationError);
    await expect(dryRun('x', 'people.csv', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(await k.db.query('select * from imp_batches')).toEqual([]);
  });

  it('rejects an XLSX with more than 50,000 rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Big');
    sheet.addRow(['Name', 'Amount']);
    for (let i = 0; i < MAX_DATA_ROWS + 1; i += 1) sheet.addRow(['A', 1]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(dryRun(buffer, 'big.xlsx')).rejects.toMatchObject({ code: 'too_many_rows' });
  }, 120_000);

  it('treats a workbook without sheets as an empty file', async () => {
    const workbook = new ExcelJS.Workbook();
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await dryRun(buffer, 'empty.xlsx');
    expect(result.status).toBe('dry_run_failed');
  });

  it('refuses a dry run whose dependency has no committed batch (BR-7)', async () => {
    k.registerDependent();
    await expect(dryRun('Name\nA\n', 'd.csv', 'dependent')).rejects.toMatchObject({
      code: 'dependency_not_committed',
    });
  });
});

describe('commit (BR-2, BR-3, BR-4, BR-9, T-4, T-5)', () => {
  it('commits end to end, writes audit and the outbox event, and drops the staged rows (AC-1)', async () => {
    const dry = await dryRun(good);
    const batch = await commit(dry.batchId);
    expect(batch).toMatchObject({
      status: 'committed',
      forced: false,
      rowCount: 3,
      committedAt: '2026-10-24T10:00:00.000Z',
    });
    expect(await countPeople()).toBe(3);
    const rows = await k.db.query<{ name: string; amount: string; joined: Date; batch_id: string }>(
      `select name, amount, joined, batch_id from tst_people where name = 'Sara'`,
    );
    expect(rows[0]).toMatchObject({ amount: '20.00', batch_id: dry.batchId });
    expect(rows[0]?.joined.toISOString()).toContain('2026-02-05');
    const events = await k.db.query<{ type: string; payload: { batchId: string } }>(
      `select type, payload from sys_outbox where type = 'import.committed'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.batchId).toBe(dry.batchId);
    const audit = await k.db.query<{ action: string }>(
      `select action from sys_audit_log where entity_id = $1 order by at, id`,
      [dry.batchId],
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['import.commit', 'import.dry_run']);
    expect(k.importer.staging.take(dry.batchId)).toBeUndefined();
  });

  it('refuses a commit for an unknown batch, another user, or a failed dry run', async () => {
    await expect(commit('018f9999-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const ok = await dryRun(good);
    await expect(commit(ok.batchId, false, runOnly, ADMIN)).rejects.toMatchObject({
      code: 'dry_run_by_other_user',
    });
    const bad = await dryRun(peopleCsv('A,x,,'));
    await expect(commit(bad.batchId)).rejects.toMatchObject({
      code: 'dry_run_failed',
      details: { errorCount: 1 },
    });
    expect(await countPeople()).toBe(0);
  });

  it('refuses to commit the same batch twice', async () => {
    const dry = await dryRun(good);
    await commit(dry.batchId);
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'batch_not_ready' });
    expect(await countPeople()).toBe(3);
  });

  it('refuses a duplicate file unless forced by a holder of the force permission', async () => {
    const first = await dryRun(good);
    await commit(first.batchId);
    const again = await dryRun(good);
    await expect(commit(again.batchId, false)).rejects.toMatchObject({ code: 'duplicate_file' });
    await expect(commit(again.batchId, true, runOnly)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await batchStatus(again.batchId)).toBe('dry_run_ok');
    const forced = await commit(again.batchId, true);
    expect(forced).toMatchObject({ status: 'committed', forced: true });
    expect(await countPeople()).toBe(6);
  });

  it('refuses when the dependency lost its committed batch, and when the dry run expired', async () => {
    k.registerDependent();
    const base = await dryRun(good);
    await commit(base.batchId);
    const dry = await dryRun('Name\nA\n', 'd.csv', 'dependent');
    await k.db.query(`update imp_batches set status = 'rolled_back' where id = $1`, [base.batchId]);
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'dependency_not_committed' });
    await k.db.query(`update imp_batches set status = 'committed' where id = $1`, [base.batchId]);
    k.importer.staging.discard(dry.batchId);
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'dry_run_expired' });
  });

  it('allows a dependent import once its dependency is committed (BR-7)', async () => {
    k.registerDependent();
    await commit((await dryRun(good)).batchId);
    const dry = await dryRun('Name\nA\n', 'd.csv', 'dependent');
    expect((await commit(dry.batchId)).status).toBe('committed');
  });

  it('rolls back everything when apply throws and records rolled_back (AC-2)', async () => {
    k.registerFailing(async (rows, ctx, tx) => {
      await tx.query(`insert into tst_people (name, amount, batch_id) values ('Half', 1, $1)`, [
        ctx.batchId,
      ]);
      throw new Error(`boom ${rows.length}`);
    });
    const dry = await dryRun(good, 'f.csv', 'failing');
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'import_failed' });
    expect(await countPeople()).toBe(0);
    expect(await batchStatus(dry.batchId)).toBe('rolled_back');
    expect(await k.db.query(`select * from sys_outbox where type = 'import.committed'`)).toEqual(
      [],
    );
    const audit = await k.db.query<{ action: string; after: { reason: string } }>(
      `select action, after from sys_audit_log where entity_id = $1 and action = 'import.commit_failed'`,
      [dry.batchId],
    );
    expect(audit[0]?.after.reason).toBe('boom 3');
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'batch_not_ready' });
  });

  it('passes a domain error from apply through unchanged and survives a non-Error throw', async () => {
    k.registerFailing(() =>
      Promise.reject(new DomainError('rule_violation', 'client_exists', 'Client exists')),
    );
    const dry = await dryRun(good, 'f.csv', 'failing');
    await expect(commit(dry.batchId)).rejects.toMatchObject({ code: 'client_exists' });
    expect(await batchStatus(dry.batchId)).toBe('rolled_back');

    // Deliberately rejects with a non-Error: third-party code may throw anything.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    k.registerFailing(() => Promise.reject('plain string'), 'failing_two');
    const dry2 = await dryRun(good, 'f.csv', 'failing_two');
    await expect(commit(dry2.batchId)).rejects.toMatchObject({ code: 'import_failed' });
    const audit = await k.db.query<{ after: { reason: string } }>(
      `select after from sys_audit_log where entity_id = $1 and action = 'import.commit_failed'`,
      [dry2.batchId],
    );
    expect(audit[0]?.after.reason).toBe('unknown error');
  });

  it('rolls back when the batch is no longer committable inside the transaction', async () => {
    k.registerFailing(async (_rows, ctx, tx) => {
      await tx.query(`update imp_batches set status = 'rolled_back' where id = $1`, [ctx.batchId]);
    }, 'racing');
    const dry = await dryRun(good, 'r.csv', 'racing');
    await expect(commit(dry.batchId)).rejects.toBeInstanceOf(ConflictError);
    expect(await batchStatus(dry.batchId)).toBe('rolled_back');
  });

  it('evicts the oldest staged dry run beyond the capacity', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) ids.push((await dryRun(peopleCsv(`P${i},1,,`))).batchId);
    expect(k.importer.staging.size()).toBe(20);
    await expect(commit(ids[0] as string)).rejects.toMatchObject({ code: 'dry_run_expired' });
    expect((await commit(ids[21] as string)).status).toBe('committed');
  });

  it('property: any valid file round-trips through dry run and commit with the same row count (T-7)', async () => {
    const name = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => s.trim() !== '' && !/[\r\n]/.test(s));
    const row = fc.record({
      name,
      whole: fc.nat(1_000_000),
      cents: fc.nat(99),
      kind: fc.constantFrom('private', 'government', ''),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(row, { minLength: 1, maxLength: 12 }), async (people) => {
        await resetImporter(k);
        const csv = peopleCsv(
          ...people.map(
            (p) =>
              `"${p.name.replaceAll('"', '""')}",${p.whole}.${String(p.cents).padStart(2, '0')},,${p.kind}`,
          ),
        );
        const dry = await dryRun(csv);
        expect(dry).toMatchObject({ status: 'dry_run_ok', rowCount: people.length });
        await commit(dry.batchId);
        expect(await countPeople()).toBe(people.length);
      }),
      { numRuns: 15, seed: 42 },
    );
  }, 120_000);
});

describe('listing and reports', () => {
  it('lists batches newest first with filters and paging, and loads one', async () => {
    const a = await dryRun(good);
    k.now.current = new Date('2026-10-24T11:00:00Z');
    const b = await dryRun(peopleCsv('Q,1,,'));
    const all = await k.importer.service.listBatches(k.db, { limit: 10, offset: 0 });
    expect(all.map((x) => x.id)).toEqual([b.batchId, a.batchId]);
    expect(
      await k.importer.service.listBatches(k.db, { importerCode: 'people', limit: 1, offset: 1 }),
    ).toHaveLength(1);
    expect(
      await k.importer.service.listBatches(k.db, { importerCode: 'other', limit: 10, offset: 0 }),
    ).toEqual([]);
    expect(await k.importer.service.getBatch(k.db, a.batchId)).toMatchObject({
      id: a.batchId,
      importerCode: 'people',
      dryRunAt: '2026-10-24T10:00:00.000Z',
      committedAt: null,
    });
    await expect(
      k.importer.service.getBatch(k.db, '018f9999-0000-7000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);
    k.now.current = new Date('2026-10-24T10:00:00Z');
  });

  it('writes an error report listing row, column and message for every fault (AC-3)', async () => {
    const dry = await dryRun(peopleCsv('A,x,nope,', ',1,,wrong'));
    const report = await k.importer.service.errorsCsv(k.db, dry.batchId);
    expect(report.fileName).toBe(`people-errors-${dry.batchId}.csv`);
    const rows = parseCsv(String(report.body));
    expect(rows[0]).toEqual(['row', 'column', 'message']);
    expect(rows.slice(1).map((r) => r.slice(0, 2))).toEqual([
      ['2', 'Amount'],
      ['2', 'Joined'],
      ['3', 'Name'],
      ['3', 'Kind'],
    ]);
    await expect(
      k.importer.service.errorsCsv(k.db, '018f9999-0000-7000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('toBatchDto', () => {
  it('maps a row without a dry-run time or commit time to nulls', () => {
    const dto = toBatchDto({
      id: 'b1',
      importer_code: 'people',
      file_name: 'p.csv',
      file_hash: 'h',
      status: 'dry_run_ok',
      forced: false,
      row_count: 1,
      error_count: 0,
      dry_run_at: null,
      committed_at: null,
      created_at: new Date('2026-10-24T10:00:00Z'),
      created_by: null,
      version: 1,
    });
    expect(dto).toMatchObject({ dryRunAt: null, committedAt: null, createdBy: null });
  });
});
