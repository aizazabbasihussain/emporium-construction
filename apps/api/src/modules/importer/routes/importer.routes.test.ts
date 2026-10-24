import { MAX_FILE_BYTES, parseCsv } from '@emporium/domain/importer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createImporterKit, peopleCsv, resetImporter, type ImporterKit } from '../test-support.js';

let k: ImporterKit;

beforeAll(async () => {
  k = await createImporterKit();
  k.registerPeople();
  k.registerFailing(() => Promise.reject(new Error('boom')));
}, 60_000);

afterAll(async () => {
  await k.close();
});

beforeEach(async () => {
  await resetImporter(k);
});

type As = 'admin' | 'accountant' | 'manager' | 'storekeeper' | 'none' | 'bad';

const headersFor = async (as: As): Promise<Record<string, string>> => {
  if (as === 'none') return {};
  if (as === 'bad') return { authorization: 'Bearer nope' };
  return { authorization: `Bearer ${await k.token(`${as}@example.test`)}` };
};

const call = async (
  method: 'GET' | 'POST',
  url: string,
  options: { as?: As; body?: unknown } = {},
) =>
  k.app.inject({
    method,
    url,
    headers: await headersFor(options.as ?? 'accountant'),
    payload: options.body as object,
  });

const BOUNDARY = '----importer-test-boundary';

const upload = async (
  code: string,
  content: string | Buffer,
  options: { as?: As; fileName?: string; field?: string } = {},
) => {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${options.field ?? 'file'}"; filename="${options.fileName ?? 'people.csv'}"\r\nContent-Type: text/csv\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return k.app.inject({
    method: 'POST',
    url: `/imports/importers/${code}/dry-run`,
    headers: {
      ...(await headersFor(options.as ?? 'accountant')),
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: Buffer.concat([head, Buffer.from(content), tail]),
  });
};

const json = <T = Record<string, unknown>>(r: { json: () => unknown }) => r.json() as T;
const code = (r: { json: () => unknown }) => (json(r).error as { code: string }).code;
const good = peopleCsv('Ali,100.50,2026-01-01,private', 'Sara,20,05/02/2026,government');

describe('authentication and permissions (T-8)', () => {
  const routes: [string, string, As[]][] = [
    ['GET', '/imports/importers', ['accountant', 'manager', 'admin']],
    ['GET', '/imports/importers/people/template', ['accountant', 'admin']],
    ['GET', '/imports/batches', ['accountant', 'manager', 'admin']],
  ];

  it.each(routes)('%s %s needs a token', async (method, url) => {
    expect((await call(method as 'GET', url, { as: 'none' })).statusCode).toBe(401);
    expect((await call(method as 'GET', url, { as: 'bad' })).statusCode).toBe(401);
  });

  it.each(routes)('%s %s allows exactly the granted roles', async (method, url, allowed) => {
    for (const as of ['admin', 'accountant', 'manager', 'storekeeper'] as const) {
      const status = (await call(method as 'GET', url, { as })).statusCode;
      expect(status === 200, `${as} -> ${status}`).toBe(allowed.includes(as));
      if (!allowed.includes(as)) expect(status).toBe(403);
    }
  });

  it('answers 403 with the missing permission code for a read-only user trying to import', async () => {
    const response = await upload('people', good, { as: 'manager' });
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { details: unknown } }>(response).error.details).toEqual({
      permission: 'importer.batch.run',
    });
    const commit = await call(
      'POST',
      '/imports/batches/018f9999-0000-7000-8000-000000000000/commit',
      {
        as: 'manager',
        body: {},
      },
    );
    expect(commit.statusCode).toBe(403);
  });
});

describe('GET /imports/importers', () => {
  it('lists registered importers with their columns', async () => {
    const response = await call('GET', '/imports/importers');
    const items = json<{ items: { code: string; columns: unknown[] }[] }>(response).items;
    expect(items.map((i) => i.code)).toEqual(['failing', 'people']);
    expect(items[1]?.columns).toHaveLength(4);
  });
});

describe('GET /imports/importers/:code/template', () => {
  it('downloads a CSV template by default and XLSX on request', async () => {
    const csv = await call('GET', '/imports/importers/people/template');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('people-template.csv');
    expect(parseCsv(csv.body)[0]).toEqual(['Name', 'Amount', 'Joined', 'Kind']);
    const xlsx = await call('GET', '/imports/importers/people/template?format=xlsx');
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('validates the format and the code, and answers 404 for an unknown importer', async () => {
    expect((await call('GET', '/imports/importers/people/template?format=pdf')).statusCode).toBe(
      400,
    );
    expect((await call('GET', '/imports/importers/Bad-Code/template')).statusCode).toBe(400);
    const missing = await call('GET', '/imports/importers/nope/template');
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('importer_not_found');
  });
});

describe('POST /imports/importers/:code/dry-run', () => {
  it('returns the batch id and counts for a clean file', async () => {
    const response = await upload('people', good);
    expect(response.statusCode).toBe(201);
    expect(json(response)).toMatchObject({
      status: 'dry_run_ok',
      rowCount: 2,
      errorCount: 0,
      errors: [],
    });
  });

  it('returns 201 with the errors for a faulty file', async () => {
    const response = await upload('people', peopleCsv('A,x,,', ',1,,'));
    expect(response.statusCode).toBe(201);
    expect(json<{ errors: unknown[] }>(response)).toMatchObject({
      status: 'dry_run_failed',
      errorCount: 2,
    });
  });

  it('fails validation without a file, with the wrong content type, a bad extension, or oversize', async () => {
    const plain = await call('POST', '/imports/importers/people/dry-run', { body: {} });
    expect(plain.statusCode).toBe(400);
    expect(code(plain)).toBe('file_required');
    const empty = await k.app.inject({
      method: 'POST',
      url: '/imports/importers/people/dry-run',
      headers: {
        ...(await headersFor('accountant')),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: `--${BOUNDARY}--\r\n`,
    });
    expect(empty.statusCode).toBe(400);
    expect(code(empty)).toBe('file_required');
    const pdf = await upload('people', 'x', { fileName: 'people.pdf' });
    expect(pdf.statusCode).toBe(400);
    expect(code(pdf)).toBe('unsupported_format');
    const big = await upload('people', Buffer.alloc(MAX_FILE_BYTES + 10, 97));
    expect(big.statusCode).toBe(400);
    expect(code(big)).toBe('file_too_large');
  });

  it('answers 404 for an unknown importer', async () => {
    const response = await upload('nope', good);
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /imports/batches/:id/commit', () => {
  const dryRun = async (content = good, as: As = 'accountant') =>
    json<{ batchId: string }>(await upload('people', content, { as })).batchId;

  it('commits and returns the batch; a retry is refused without duplicating rows', async () => {
    const batchId = await dryRun();
    const response = await call('POST', `/imports/batches/${batchId}/commit`, { body: {} });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toMatchObject({ id: batchId, status: 'committed', rowCount: 2 });
    const retry = await call('POST', `/imports/batches/${batchId}/commit`, { body: {} });
    expect(retry.statusCode).toBe(422);
    expect(code(retry)).toBe('batch_not_ready');
    const rows = await k.db.query('select * from tst_people');
    expect(rows).toHaveLength(2);
  });

  it('accepts an empty body and validates the body and id', async () => {
    const batchId = await dryRun();
    expect((await call('POST', `/imports/batches/${batchId}/commit`)).statusCode).toBe(200);
    expect(
      (await call('POST', `/imports/batches/${batchId}/commit`, { body: { force: 'yes' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/imports/batches/not-a-uuid/commit', { body: {} })).statusCode,
    ).toBe(400);
  });

  it('answers 404 for an unknown batch and 403 for a batch from another user', async () => {
    const missing = await call(
      'POST',
      '/imports/batches/018f9999-0000-7000-8000-000000000000/commit',
      {
        body: {},
      },
    );
    expect(missing.statusCode).toBe(404);
    const batchId = await dryRun(good, 'admin');
    const other = await call('POST', `/imports/batches/${batchId}/commit`, { body: {} });
    expect(other.statusCode).toBe(403);
    expect(code(other)).toBe('dry_run_by_other_user');
  });

  it('refuses a duplicate file with 409 and force without the permission with 403', async () => {
    await call('POST', `/imports/batches/${await dryRun()}/commit`, { body: {} });
    const again = await dryRun();
    const duplicate = await call('POST', `/imports/batches/${again}/commit`, { body: {} });
    expect(duplicate.statusCode).toBe(409);
    expect(code(duplicate)).toBe('duplicate_file');
    const forbidden = await call('POST', `/imports/batches/${again}/commit`, {
      body: { force: true },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('lets an admin force a re-import', async () => {
    await call('POST', `/imports/batches/${await dryRun(good, 'admin')}/commit`, {
      as: 'admin',
      body: {},
    });
    const again = await dryRun(good, 'admin');
    const forced = await call('POST', `/imports/batches/${again}/commit`, {
      as: 'admin',
      body: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(json(forced)).toMatchObject({ forced: true, status: 'committed' });
  });

  it('answers 422 and leaves no rows when the importer fails', async () => {
    const dry = json<{ batchId: string }>(await upload('failing', good));
    const response = await call('POST', `/imports/batches/${dry.batchId}/commit`, { body: {} });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('import_failed');
    expect(await k.db.query('select * from tst_people')).toEqual([]);
    const batch = await call('GET', `/imports/batches/${dry.batchId}`);
    expect(json(batch)).toMatchObject({ status: 'rolled_back' });
  });
});

describe('batches and error report', () => {
  it('lists batches for readers, with validation of the query', async () => {
    await upload('people', good);
    const response = await call('GET', '/imports/batches?importerCode=people&limit=5', {
      as: 'manager',
    });
    expect(json<{ items: unknown[] }>(response).items).toHaveLength(1);
    expect((await call('GET', '/imports/batches?limit=0')).statusCode).toBe(400);
    expect((await call('GET', '/imports/batches?importerCode=Bad')).statusCode).toBe(400);
  });

  it('shows one batch and 404s an unknown one', async () => {
    const { batchId } = json<{ batchId: string }>(await upload('people', good));
    const found = await call('GET', `/imports/batches/${batchId}`, { as: 'manager' });
    expect(json(found)).toMatchObject({ id: batchId, importerCode: 'people' });
    expect(
      (await call('GET', '/imports/batches/018f9999-0000-7000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('downloads the error report as CSV listing row, column and message (AC-3)', async () => {
    const { batchId } = json<{ batchId: string }>(
      await upload('people', peopleCsv('A,x,,', ',1,,')),
    );
    const response = await call('GET', `/imports/batches/${batchId}/errors.csv`, { as: 'manager' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(`${batchId}.csv`);
    expect(parseCsv(response.body.replace('﻿', ''))).toEqual([
      ['row', 'column', 'message'],
      ['2', 'Amount', 'Must be a plain decimal number without thousands separators'],
      ['3', 'Name', 'A value is required'],
    ]);
    const missing = await call(
      'GET',
      '/imports/batches/018f9999-0000-7000-8000-000000000000/errors.csv',
    );
    expect(missing.statusCode).toBe(404);
    expect((await call('GET', '/imports/batches/xyz/errors.csv')).statusCode).toBe(400);
  });
});
