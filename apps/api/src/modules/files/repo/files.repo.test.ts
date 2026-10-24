import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findAttachment,
  findByChecksum,
  insertAttachment,
  listByEntity,
  listPurgeable,
  markPurged,
  softDelete,
  type NewAttachment,
} from './files.repo.js';

let db: SqlDb;
const id = (n: number) => `018f6666-2222-7000-8000-${String(n).padStart(12, '0')}`;
const user = id(900);
const entity = id(500);
const at = new Date('2026-10-25T10:00:00Z');
const sum = (c: string) => c.repeat(64);

const attachment = (n: number, over: Partial<NewAttachment> = {}): NewAttachment => ({
  id: id(n),
  entityType: 'test_doc',
  entityId: entity,
  storageKey: id(1000 + n),
  fileName: 'site.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 1234,
  checksum: sum((n % 16).toString(16)),
  caption: 'north wall',
  takenAt: new Date('2026-10-24T08:30:00Z'),
  latitude: 33.684422,
  longitude: 73.047884,
  retainForever: false,
  uploadedBy: user,
  at,
  ...over,
});

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe('fil_attachments', () => {
  it('stores and returns an attachment with its optional fields', async () => {
    const row = await insertAttachment(db, attachment(1));
    expect(row).toMatchObject({
      id: id(1),
      entity_type: 'test_doc',
      file_name: 'site.jpg',
      size_bytes: 1234,
      caption: 'north wall',
      latitude: 33.684422,
      longitude: 73.047884,
      retain_forever: false,
      uploaded_by: user,
      version: 1,
      deleted_at: null,
    });
    expect(row?.taken_at?.toISOString()).toBe('2026-10-24T08:30:00.000Z');
    expect(await findAttachment(db, id(1))).toMatchObject({ id: id(1) });
  });

  it('stores an attachment without caption, time or position', async () => {
    const row = await insertAttachment(
      db,
      attachment(2, { caption: null, takenAt: null, latitude: null, longitude: null }),
    );
    expect(row).toMatchObject({ caption: null, taken_at: null, latitude: null, longitude: null });
  });

  it('does not insert the same bytes twice for one entity (BR-2)', async () => {
    expect(await insertAttachment(db, attachment(3))).toBeDefined();
    expect(await insertAttachment(db, attachment(4, { checksum: sum('3') }))).toBeUndefined();
    expect((await findByChecksum(db, 'test_doc', entity, sum('3')))?.id).toBe(id(3));
    expect(await findByChecksum(db, 'test_doc', entity, sum('f'))).toBeUndefined();
  });

  it('allows the same bytes on another entity', async () => {
    const other = await insertAttachment(
      db,
      attachment(5, { entityId: id(501), checksum: sum('3') }),
    );
    expect(other).toBeDefined();
  });

  it('lists the live attachments of one entity in upload order', async () => {
    const rows = await listByEntity(db, 'test_doc', entity);
    expect(rows.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(await listByEntity(db, 'other_doc', entity)).toEqual([]);
  });

  it('finds a row for update', async () => {
    expect((await findAttachment(db, id(1), true))?.id).toBe(id(1));
    expect(await findAttachment(db, id(777))).toBeUndefined();
  });

  it('rejects content that violates the table checks', async () => {
    await expect(
      insertAttachment(db, attachment(6, { contentType: 'application/x-msdownload' })),
    ).rejects.toThrow();
    await expect(insertAttachment(db, attachment(7, { checksum: 'abc' }))).rejects.toThrow();
    await expect(insertAttachment(db, attachment(8, { entityType: '../x' }))).rejects.toThrow();
    await expect(insertAttachment(db, attachment(9, { latitude: 120 }))).rejects.toThrow();
  });
});

describe('soft delete and purge candidates (BR-5)', () => {
  it('hides a removed attachment, bumps its version and frees the checksum', async () => {
    await softDelete(db, id(1), user, new Date('2026-09-01T00:00:00Z'));
    expect(await findAttachment(db, id(1))).toBeUndefined();
    expect((await listByEntity(db, 'test_doc', entity)).map((r) => r.id)).toEqual([id(2), id(3)]);
    expect(await insertAttachment(db, attachment(10, { checksum: sum('1') }))).toBeDefined();
    const [row] = await db.query<{ version: number; updated_by: string }>(
      'select version, updated_by from fil_attachments where id = $1',
      [id(1)],
    );
    expect(row).toEqual({ version: 2, updated_by: user });
  });

  it('lists removed files older than the cutoff, never the retained ones', async () => {
    await insertAttachment(db, attachment(11, { retainForever: true }));
    await softDelete(db, id(11), user, new Date('2026-08-01T00:00:00Z'));
    await softDelete(db, id(2), user, new Date('2026-10-20T00:00:00Z'));

    const due = await listPurgeable(db, new Date('2026-09-25T00:00:00Z'), 10);
    expect(due.map((r) => r.id)).toEqual([id(1)]);
    expect(await listPurgeable(db, new Date('2026-09-25T00:00:00Z'), 0)).toEqual([]);
    expect(
      (await listPurgeable(db, new Date('2026-11-01T00:00:00Z'), 10)).map((r) => r.id),
    ).toEqual([id(1), id(2)]);
  });

  it('stops listing a file once it is marked purged', async () => {
    await markPurged(db, id(1), at);
    expect(
      (await listPurgeable(db, new Date('2026-11-01T00:00:00Z'), 10)).map((r) => r.id),
    ).toEqual([id(2)]);
  });
});
