import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  EXE,
  JPEG,
  NOBODY,
  PDF,
  PM,
  PNG,
  createFilesKit,
  interceptQuery,
  serviceOf,
  type FilesKit,
} from '../test-support.js';
import type { FileStore } from '../store/file-store.js';

let kit: FilesKit;

beforeAll(async () => {
  kit = await createFilesKit();
}, 60_000);
afterAll(() => kit.close());

const upload = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityType: 'test_doc',
  entityId,
  fileName: 'wall.jpg',
  bytes: JPEG,
  ...over,
});

const attach = (entityId: string, over: Record<string, unknown> = {}, userId = ADMIN) =>
  kit.db.transaction((tx) => kit.files.attach(upload(entityId, over), kit.actor(userId), tx));

const entityFor = (...users: string[]) => {
  const entity = kit.entity();
  kit.allow(entity, ...users);
  return entity;
};

describe('attach (AC-1, T-1, T-2)', () => {
  it('stores the bytes, the metadata and the audit and outbox entries', async () => {
    const entity = entityFor(ADMIN);
    const { attachment, created } = await attach(entity, {
      caption: '  north wall  ',
      takenAt: new Date('2026-10-24T08:30:00Z'),
      latitude: 33.7,
      longitude: 73.0,
    });
    expect(created).toBe(true);
    expect(attachment).toMatchObject({
      entityType: 'test_doc',
      entityId: entity,
      fileName: 'wall.jpg',
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
      caption: 'north wall',
      takenAt: '2026-10-24T08:30:00.000Z',
      latitude: 33.7,
      longitude: 73,
      uploadedBy: ADMIN,
      version: 1,
    });
    expect(attachment.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kit.objects?.size).toBeGreaterThan(0);

    const audit = await kit.db.query(
      `select action from sys_audit_log where entity_id = $1 and action = 'file.attach'`,
      [attachment.id],
    );
    expect(audit).toHaveLength(1);
    const events = await kit.db.query(
      `select type from sys_outbox where payload->>'attachmentId' = $1`,
      [attachment.id],
    );
    expect(events).toEqual([{ type: 'file.attached' }]);
  });

  it('decides the type from the bytes and keeps empty captions as null', async () => {
    const entity = entityFor(ADMIN);
    const { attachment } = await attach(entity, { fileName: 'plan.txt', bytes: PDF, caption: ' ' });
    expect(attachment).toMatchObject({ contentType: 'application/pdf', caption: null });
    expect(attachment.takenAt).toBeNull();
    expect(attachment.latitude).toBeNull();
  });

  it('rejects an executable renamed to .jpg, empty and oversize files', async () => {
    const entity = entityFor(ADMIN);
    await expect(attach(entity, { fileName: 'photo.jpg', bytes: EXE })).rejects.toMatchObject({
      code: 'file_type_not_allowed',
    });
    await expect(attach(entity, { bytes: new Uint8Array() })).rejects.toMatchObject({
      code: 'file_empty',
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG);
    await expect(attach(entity, { bytes: big })).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('rejects path traversal in the file name and in the entity type', async () => {
    const entity = entityFor(ADMIN);
    await expect(attach(entity, { fileName: '../../etc/passwd.jpg' })).rejects.toMatchObject({
      code: 'file_name_invalid',
    });
    await expect(attach(entity, { entityType: '../x' })).rejects.toMatchObject({
      code: 'entity_type_invalid',
    });
  });

  it('returns the existing attachment for identical bytes and stores one object (BR-2)', async () => {
    const entity = entityFor(ADMIN);
    const first = await attach(entity, { bytes: PNG, fileName: 'a.png' });
    const objectsBefore = kit.objects?.size;
    const again = await attach(entity, { bytes: PNG, fileName: 'renamed.png' });
    expect(again.created).toBe(false);
    expect(again.attachment.id).toBe(first.attachment.id);
    expect(kit.objects?.size).toBe(objectsBefore);
    const rows = await kit.db.query('select id from fil_attachments where entity_id = $1', [
      entity,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('names objects by random UUID, never by the original file name (BR-3)', async () => {
    const entity = entityFor(ADMIN);
    await attach(entity, { fileName: 'secret plan.jpg' });
    const [row] = await kit.db.query<{ storage_key: string }>(
      'select storage_key from fil_attachments where entity_id = $1',
      [entity],
    );
    expect(row?.storage_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires the upload permission, a registered entity type and the entity check', async () => {
    const entity = entityFor(ADMIN);
    await expect(
      kit.db.transaction((tx) => kit.files.attach(upload(entity), kit.actor(ADMIN, []), tx)),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(attach(entity, { entityType: 'mystery' })).rejects.toMatchObject({
      code: 'entity_type_unknown',
    });
    await expect(attach(entity, {}, PM)).rejects.toMatchObject({ code: 'entity_not_found' });
  });
});

describe('registerFileAccess', () => {
  it('refuses a second registration and an invalid entity type', () => {
    expect(() => kit.files.registerFileAccess('test_doc', () => Promise.resolve(true))).toThrow(
      expect.objectContaining({ code: 'file_access_registered' }),
    );
    expect(() => kit.files.registerFileAccess('Bad Type', () => Promise.resolve(true))).toThrow(
      expect.objectContaining({ code: 'entity_type_invalid' }),
    );
  });
});

describe('list and signed URL (AC-1, T-4)', () => {
  it('lists for a permitted user and hides the entity from others', async () => {
    const entity = entityFor(ADMIN, PM);
    const { attachment } = await attach(entity);
    const items = await kit.files.list(kit.db, kit.actor(PM), 'test_doc', entity);
    expect(items.map((i) => i.id)).toEqual([attachment.id]);

    const stranger = entityFor(ADMIN);
    await expect(kit.files.list(kit.db, kit.actor(PM), 'test_doc', stranger)).rejects.toMatchObject(
      { code: 'entity_not_found' },
    );
    await expect(
      kit.files.list(kit.db, kit.actor(NOBODY, []), 'test_doc', entity),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(kit.files.list(kit.db, kit.actor(PM), 'mystery', entity)).rejects.toMatchObject({
      code: 'entity_not_found',
    });
  });

  it('issues a five-minute link only after the checks', async () => {
    const entity = entityFor(ADMIN, PM);
    const { attachment } = await attach(entity);
    const link = await kit.files.getSignedUrl(kit.db, kit.actor(PM), attachment.id);
    expect(link.url).toContain('https://storage.example.test/');
    expect(link.expiresAt).toBe('2026-10-25T10:05:00.000Z');
    const [row] = await kit.db.query<{ storage_key: string }>(
      'select storage_key from fil_attachments where id = $1',
      [attachment.id],
    );
    expect(link.url).toContain(row?.storage_key);

    await expect(
      kit.files.getSignedUrl(kit.db, kit.actor(ACCOUNTANT), attachment.id),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      kit.files.getSignedUrl(kit.db, kit.actor(PM, []), attachment.id),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      kit.files.getSignedUrl(kit.db, kit.actor(PM), '018f0000-0000-7000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'attachment_not_found' });
  });
});

describe('remove, purge and retention (T-5)', () => {
  it('removes softly, checks the version and the permission', async () => {
    const entity = entityFor(ADMIN);
    const { attachment } = await attach(entity);
    await expect(
      kit.db.transaction((tx) => kit.files.remove(attachment.id, kit.actor(ADMIN, []), tx)),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      kit.db.transaction((tx) => kit.files.remove(attachment.id, kit.actor(PM), tx)),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(
      kit.db.transaction((tx) => kit.files.remove(attachment.id, kit.actor(ADMIN), tx, 9)),
    ).rejects.toMatchObject({ code: 'version_conflict' });

    const removed = await kit.db.transaction((tx) =>
      kit.files.remove(attachment.id, kit.actor(ADMIN), tx, 1),
    );
    expect(removed).toMatchObject({ id: attachment.id, version: 2 });
    expect(await kit.files.list(kit.db, kit.actor(ADMIN), 'test_doc', entity)).toEqual([]);
    await expect(
      kit.db.transaction((tx) => kit.files.remove(attachment.id, kit.actor(ADMIN), tx)),
    ).rejects.toMatchObject({ code: 'attachment_not_found' });
    const [{ deleted_at }] = (await kit.db.query<{ deleted_at: Date }>(
      'select deleted_at from fil_attachments where id = $1',
      [attachment.id],
    )) as [{ deleted_at: Date }];
    expect(deleted_at.toISOString()).toBe(kit.now.current.toISOString());
  });

  it('purges objects 30 days after removal and keeps retain_forever files', async () => {
    const plain = entityFor(ADMIN);
    const ledger = entityFor(ADMIN);
    const a = await attach(plain, { bytes: PNG });
    const b = await attach(ledger, { entityType: 'ledger_doc', bytes: PDF });
    const keyOf = async (id: string) =>
      (
        (await kit.db.query<{ storage_key: string }>(
          'select storage_key from fil_attachments where id = $1',
          [id],
        )) as [{ storage_key: string }]
      )[0].storage_key;
    const [keyA, keyB] = [await keyOf(a.attachment.id), await keyOf(b.attachment.id)];
    for (const id of [a.attachment.id, b.attachment.id]) {
      await kit.db.transaction((tx) => kit.files.remove(id, kit.actor(ADMIN), tx));
    }

    kit.now.current = new Date('2026-11-23T10:00:00Z'); // 29 days later
    expect(await kit.files.purgeExpired(kit.db)).toBe(0);
    expect(await kit.store.exists(keyA)).toBe(true);

    kit.now.current = new Date('2026-11-24T10:00:00Z'); // 30 days later
    // Two files are due: the one removed by the previous test and this test's plain file.
    expect(await kit.files.purgeExpired(kit.db)).toBe(2);
    expect(await kit.store.exists(keyA)).toBe(false);
    expect(await kit.store.exists(keyB)).toBe(true);
    expect(await kit.files.purgeExpired(kit.db)).toBe(0);

    const purged = await kit.db.query(`select id from sys_audit_log where action = 'file.purge'`);
    expect(purged).toHaveLength(2);
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });
});

describe('failure handling around the object store', () => {
  it('drops the stored object when the insert fails', async () => {
    const entity = entityFor(ADMIN);
    const before = kit.objects?.size;
    const failing = interceptQuery(kit.db, (sql) =>
      sql.includes('insert into fil_attachments')
        ? Promise.reject(new Error('disk full'))
        : undefined,
    );
    await expect(
      serviceOf(kit).attach(upload(entity, { bytes: PDF }), kit.actor(ADMIN), failing),
    ).rejects.toThrow('disk full');
    expect(kit.objects?.size).toBe(before);
  });

  it('keeps the winner and drops its own object when a concurrent upload got there first', async () => {
    const entity = entityFor(ADMIN);
    const winner = await attach(entity, { bytes: PNG });
    const objectsBefore = kit.objects?.size;
    let firstLookup = true;
    const racing = interceptQuery(kit.db, (sql) => {
      if (firstLookup && sql.includes('checksum_sha256 = $3')) {
        firstLookup = false;
        return Promise.resolve([]);
      }
      return undefined;
    });
    const result = await serviceOf(kit).attach(
      upload(entity, { bytes: PNG }),
      kit.actor(ADMIN),
      racing,
    );
    expect(result).toMatchObject({ created: false });
    expect(result.attachment.id).toBe(winner.attachment.id);
    expect(kit.objects?.size).toBe(objectsBefore);
  });

  it('does not fail when the store was told to delete an unknown key', async () => {
    const store: FileStore = {
      put: () => Promise.resolve(),
      getSignedUrl: () => Promise.resolve('x'),
      delete: () => Promise.resolve(),
      exists: () => Promise.resolve(false),
    };
    const service = serviceOf(kit, store);
    expect(await service.purgeExpired(kit.db)).toBe(0);
  });
});
