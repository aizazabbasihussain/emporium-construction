import { filesPermissions } from '@emporium/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Db, FileActor } from '../types.js';
import { assertEntityAccess, assertFilePermission } from './files.policy.js';

const actor = (permissions: string[]): FileActor => ({
  userId: 'u1',
  roles: [],
  scopes: [],
  permissions: new Set(permissions),
  requestId: null,
});

describe('assertFilePermission', () => {
  it.each([
    ['upload', filesPermissions.upload],
    ['read', filesPermissions.read],
    ['remove', filesPermissions.remove],
  ] as const)('allows %s with its permission and refuses without it', (operation, code) => {
    expect(() => assertFilePermission(actor([code]), operation)).not.toThrow();
    expect(() => assertFilePermission(actor([]), operation)).toThrow(
      expect.objectContaining({ kind: 'forbidden' }),
    );
    const others = Object.values(filesPermissions).filter((p) => p !== code);
    expect(() => assertFilePermission(actor(others), operation)).toThrow(
      expect.objectContaining({ kind: 'forbidden' }),
    );
  });
});

describe('assertEntityAccess', () => {
  const db = {} as Db;

  it('passes when the owning module agrees and hands it the whole request', async () => {
    const check = vi.fn().mockResolvedValue(true);
    const request = { actor: actor([]), entityId: 'e1', operation: 'read' as const, db };
    await expect(assertEntityAccess(check, request)).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledWith(request);
  });

  it('reports a refusal as not found', async () => {
    await expect(
      assertEntityAccess(() => Promise.resolve(false), {
        actor: actor([]),
        entityId: 'e1',
        operation: 'remove',
        db,
      }),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'entity_not_found' });
  });
});
