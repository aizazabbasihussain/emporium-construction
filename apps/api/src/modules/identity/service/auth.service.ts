import { UnauthorizedError, DomainError } from '@emporium/domain';
import { unionPermissions } from '@emporium/domain/identity';
import type { Platform } from '../../platform/index.js';
import {
  bindSubject,
  findUserByEmail,
  findUserBySubject,
  selectRoleCodes,
  selectRolePermissions,
  selectScopes,
  type UserRow,
} from '../repo/identity.repo.js';
import type { CurrentUser, Db } from '../types.js';
import type { AuthVerifier } from './jwt-verifier.service.js';

export interface AuthService {
  /**
   * Maps a bearer token to an active user (BR-1, BR-2, BR-6). Nothing about the user is cached:
   * status, roles and permissions are read on every request, so disabling a user or editing a
   * role takes effect on the next request (well inside the 60 seconds BR-6 and BR-7 allow).
   */
  authenticate(db: Db, token: string): Promise<CurrentUser>;
  /** Loads the access profile of a user already known to be active. */
  load(db: Db, user: UserRow): Promise<CurrentUser>;
}

export function createAuthService(deps: {
  verifier: AuthVerifier;
  platform: Platform;
}): AuthService {
  const load: AuthService['load'] = async (db, user) => {
    const roles = await selectRoleCodes(db, user.id);
    const grants = await selectRolePermissions(db, roles);
    return {
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      locale: user.locale,
      version: user.version,
      roles,
      permissions: unionPermissions(grants),
      scopes: await selectScopes(db, user.id),
    };
  };

  /** First login: bind the verified subject to the pre-created user with the same email (BR-2). */
  const bindFirstLogin = async (db: Db, subject: string, email: string | null) => {
    const candidate = email === null ? undefined : await findUserByEmail(db, email);
    if (candidate === undefined || candidate.auth_subject !== null) {
      throw new UnauthorizedError('unknown_user', 'No account exists for this login');
    }
    return db.transaction(async (tx) => {
      if (!(await bindSubject(tx, candidate.id, subject))) {
        throw new UnauthorizedError('unknown_user', 'No account exists for this login');
      }
      await deps.platform.audit.record(
        {
          actorUserId: candidate.id,
          action: 'user.bind_subject',
          entityType: 'user',
          entityId: candidate.id,
          after: { email: candidate.email },
        },
        tx,
      );
      await deps.platform.events.publish(
        { type: 'identity.user.first_login', payload: { userId: candidate.id } },
        tx,
      );
      return { ...candidate, auth_subject: subject, version: candidate.version + 1 };
    });
  };

  return {
    load,
    async authenticate(db, token) {
      const claims = await deps.verifier.verify(token);
      const user =
        (await findUserBySubject(db, claims.subject)) ??
        (await bindFirstLogin(db, claims.subject, claims.email));
      if (user.status === 'disabled') {
        throw new DomainError('forbidden', 'user_disabled', 'This account is disabled');
      }
      return load(db, user);
    },
  };
}
