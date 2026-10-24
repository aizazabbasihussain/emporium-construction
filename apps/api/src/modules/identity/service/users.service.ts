import { ConflictError, NotFoundError, ValidationError } from '@emporium/domain';
import {
  ADMIN_ROLE,
  assertRoleChangeAllowed,
  assertStatusChangeAllowed,
  type ScopeGrant,
} from '@emporium/domain/identity';
import type { Platform } from '../../platform/index.js';
import {
  countActiveAdmins,
  existingRoleCodes,
  findUserByEmail,
  findUserById,
  insertUser,
  listUsers,
  replaceUserRoles,
  replaceUserScopes,
  selectAllScopes,
  selectAllUserRoles,
  selectRoleCodes,
  selectScopes,
  touchLogin,
  updateUser,
  type UserRow,
} from '../repo/identity.repo.js';
import type { ActionContext, Db, UserDto } from '../types.js';

export interface NewUser {
  email: string;
  fullName: string;
  phone?: string | null;
  roles?: readonly string[];
}

export interface UserPatch {
  fullName?: string;
  phone?: string | null;
  status?: 'active' | 'disabled';
  version: number;
}

export interface UsersService {
  list(db: Db): Promise<UserDto[]>;
  create(input: NewUser, ctx: ActionContext, tx: Db): Promise<UserDto>;
  update(id: string, patch: UserPatch, ctx: ActionContext, tx: Db): Promise<UserDto>;
  setRoles(
    id: string,
    roles: readonly string[],
    version: number,
    ctx: ActionContext,
    tx: Db,
  ): Promise<UserDto>;
  setScopes(
    id: string,
    scopes: readonly ScopeGrant[],
    version: number,
    ctx: ActionContext,
    tx: Db,
  ): Promise<UserDto>;
  /** A user changes their own language (PATCH /me). */
  setLocale(
    id: string,
    locale: string,
    version: number,
    ctx: ActionContext,
    tx: Db,
  ): Promise<UserDto>;
  recordLogin(id: string, db: Db): Promise<void>;
  /** Creates the first admin from configuration if no user has that email yet; otherwise nothing. */
  ensureAdmin(email: string, tx: Db): Promise<boolean>;
}

function toDto(row: UserRow, roles: string[], scopes: ScopeGrant[]): UserDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    status: row.status,
    locale: row.locale,
    lastLoginAt: row.last_login_at === null ? null : new Date(row.last_login_at).toISOString(),
    version: row.version,
    roles,
    scopes,
  };
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function createUsersService(deps: {
  platform: Platform;
  newId: () => string;
}): UsersService {
  const { audit, events } = deps.platform;

  const requireUser = async (tx: Db, id: string): Promise<UserRow> => {
    const row = await findUserById(tx, id, true);
    if (row === undefined) throw new NotFoundError('user_not_found', 'User not found');
    return row;
  };

  const snapshot = async (db: Db, row: UserRow): Promise<UserDto> =>
    toDto(row, await selectRoleCodes(db, row.id), await selectScopes(db, row.id));

  const assertRolesExist = async (tx: Db, roles: readonly string[]) => {
    const found = new Set(await existingRoleCodes(tx, roles));
    const missing = roles.filter((role) => !found.has(role));
    if (missing.length > 0) {
      throw new ValidationError('unknown_role', `Unknown role: ${missing.join(', ')}`, { missing });
    }
  };

  /** Writes the audit row and outbox event that every mutation owes (constitution 5.9, 5.12). */
  const record = async (
    action: string,
    ctx: ActionContext,
    userId: string,
    before: UserDto | null,
    after: UserDto,
    tx: Db,
  ) => {
    await audit.record({ ...ctx, action, entityType: 'user', entityId: userId, before, after }, tx);
    await events.publish({ type: `identity.${action}`, payload: { userId } }, tx);
  };

  const changeAccess = async (
    id: string,
    version: number,
    ctx: ActionContext,
    tx: Db,
    action: string,
    apply: (user: UserRow, before: UserDto) => Promise<void>,
  ): Promise<UserDto> => {
    const current = await requireUser(tx, id);
    const before = await snapshot(tx, current);
    await apply(current, before);
    const updated = await updateUser(tx, {
      id,
      expectedVersion: version,
      patch: {},
      actor: ctx.actorUserId,
    });
    const after = await snapshot(tx, updated);
    await record(action, ctx, id, before, after, tx);
    return after;
  };

  return {
    async list(db) {
      const [rows, roles, scopes] = await Promise.all([
        listUsers(db),
        selectAllUserRoles(db),
        selectAllScopes(db),
      ]);
      return rows.map((row) =>
        toDto(
          row,
          roles.filter((r) => r.user_id === row.id).map((r) => r.role_code),
          scopes
            .filter((s) => s.user_id === row.id)
            .map((s) => ({ type: s.scope_type, id: s.scope_id })),
        ),
      );
    },

    async create(input, ctx, tx) {
      const roles = unique(input.roles ?? []);
      await assertRolesExist(tx, roles);
      if ((await findUserByEmail(tx, input.email)) !== undefined) {
        throw new ConflictError('email_taken', 'A user with this email already exists');
      }
      const row = await insertUser(tx, {
        id: deps.newId(),
        email: input.email,
        fullName: input.fullName,
        phone: input.phone ?? null,
        actor: ctx.actorUserId,
      });
      await replaceUserRoles(tx, row.id, roles);
      const created = await snapshot(tx, row);
      await record('user.created', ctx, row.id, null, created, tx);
      return created;
    },

    async update(id, patch, ctx, tx) {
      const current = await requireUser(tx, id);
      const before = await snapshot(tx, current);
      if (patch.status !== undefined) {
        assertStatusChangeAllowed({
          actorId: ctx.actorUserId ?? '',
          targetId: id,
          from: current.status,
          to: patch.status,
          targetRoles: before.roles,
          activeAdminCount: await countActiveAdmins(tx),
        });
      }
      const { version, ...fields } = patch;
      const updated = await updateUser(tx, {
        id,
        expectedVersion: version,
        patch: {
          ...(fields.fullName === undefined ? {} : { full_name: fields.fullName }),
          ...(fields.phone === undefined ? {} : { phone: fields.phone }),
          ...(fields.status === undefined ? {} : { status: fields.status }),
        },
        actor: ctx.actorUserId,
      });
      const after = await snapshot(tx, updated);
      await record(
        patch.status !== undefined && patch.status !== current.status
          ? `user.${patch.status === 'disabled' ? 'disabled' : 'enabled'}`
          : 'user.updated',
        ctx,
        id,
        before,
        after,
        tx,
      );
      return after;
    },

    setRoles(id, roles, version, ctx, tx) {
      const wanted = unique(roles);
      return changeAccess(id, version, ctx, tx, 'user.roles_changed', async (current, before) => {
        await assertRolesExist(tx, wanted);
        assertRoleChangeAllowed({
          actorId: ctx.actorUserId ?? '',
          targetId: id,
          targetStatus: current.status,
          currentRoles: before.roles,
          newRoles: wanted,
          activeAdminCount: await countActiveAdmins(tx),
        });
        await replaceUserRoles(tx, id, wanted);
      });
    },

    setScopes(id, scopes, version, ctx, tx) {
      return changeAccess(id, version, ctx, tx, 'user.scopes_changed', async () => {
        const seen = new Set<string>();
        const distinct = scopes.filter((scope) => {
          const key = `${scope.type}:${scope.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        await replaceUserScopes(tx, id, distinct);
      });
    },

    async setLocale(id, locale, version, ctx, tx) {
      const current = await requireUser(tx, id);
      const before = await snapshot(tx, current);
      const updated = await updateUser(tx, {
        id,
        expectedVersion: version,
        patch: { locale },
        actor: ctx.actorUserId,
      });
      const after = await snapshot(tx, updated);
      await record('user.updated', ctx, id, before, after, tx);
      return after;
    },

    recordLogin: (id, db) => touchLogin(db, id),

    async ensureAdmin(email, tx) {
      if ((await findUserByEmail(tx, email)) !== undefined) return false;
      const row = await insertUser(tx, {
        id: deps.newId(),
        email,
        fullName: 'Administrator',
        phone: null,
        actor: null,
      });
      await replaceUserRoles(tx, row.id, [ADMIN_ROLE]);
      await record(
        'user.created',
        { actorUserId: null, requestId: null },
        row.id,
        null,
        await snapshot(tx, row),
        tx,
      );
      return true;
    },
  };
}
