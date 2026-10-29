import { RuleViolationError, ValidationError } from '@emporium/domain';
import type { ScopeGrant } from '@emporium/domain/identity';
import { BusinessDate } from '@emporium/domain/kernel';
import { planPeriodInsert, type Period } from '@emporium/domain/workforce';
import { teamSeries } from '@emporium/shared';
import {
  assertFound,
  assertRemovable,
  assertSupervisor,
  assertTeamReachable,
  assertUpdated,
  assertWorkerActive,
  teamLimit,
} from '../policy/workforce.policy.js';
import {
  countMembers,
  deleteMember,
  findTeam,
  findWorker,
  insertMember,
  insertTeam,
  listMembersOn,
  listMembershipsOfWorker,
  listTeams,
  listTeamsOfSupervisor,
  setMemberEnd,
  softDeleteTeam,
  updateTeam,
  type MemberRow,
  type TeamRow,
} from '../repo/workforce.repo.js';
import type { Actor, Db, TeamDetailDto, TeamDto, TeamMemberDto } from '../types.js';
import { createRecorder, textOrNull } from './support.js';
import type { WorkforceDeps } from './workers.service.js';

export interface TeamFields {
  name: string;
  supervisorUserId: string;
}

export interface CreateTeamInput extends TeamFields {
  /** Taken from the team number series when left out. */
  code?: string | undefined;
}

export interface TeamPatch {
  name?: string | undefined;
  supervisorUserId?: string | undefined;
  active?: boolean | undefined;
}

export interface TeamsService {
  create(input: CreateTeamInput, actor: Actor, tx: Db): Promise<TeamDto>;
  update(
    id: string,
    patch: TeamPatch,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<TeamDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  get(db: Db, id: string, actor: Actor): Promise<TeamDetailDto>;
  list(db: Db, actor: Actor): Promise<TeamDto[]>;
  /** `GET /workforce/teams/mine`: the active teams the caller supervises, with their members. */
  mine(db: Db, actor: Actor): Promise<TeamDetailDto[]>;
  /**
   * BR-4: makes `workerIds` the members of the team from the date (today by default). A worker who
   * is added leaves their old team the day before; a worker left out ends the day before.
   */
  setMembers(
    id: string,
    input: { workerIds: readonly string[]; date?: string | undefined },
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<TeamDetailDto>;
  /** One membership period, as the importer loads them (BR-9). */
  addMembership(
    input: { teamId: string; workerId: string; fromDate: string; toDate?: string | null },
    actor: Actor,
    tx: Db,
  ): Promise<void>;
  /** Module interface `getTeamMembers(teamId, date)`. */
  getTeamMembers(db: Db, teamId: string, date: string): Promise<TeamMemberDto[]>;
  /** Module interface `listTeamsForSupervisor(userId)`. */
  listTeamsForSupervisor(db: Db, userId: string): Promise<TeamDto[]>;
}

const teamOf = (row: TeamRow): TeamDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  supervisorUserId: row.supervisor_user_id,
  active: row.active,
  version: row.version,
});

const memberOf = (row: MemberRow): TeamMemberDto => ({
  teamId: row.team_id,
  workerId: row.worker_id,
  code: row.code,
  fullName: row.full_name,
  tradeCode: row.trade_code,
  fromDate: row.from_date,
  toDate: row.to_date,
});

const periodId = (teamId: string, fromDate: string) => `${teamId}|${fromDate}`;

export function createTeamsService(deps: WorkforceDeps): TeamsService {
  const { platform, clock, newId, identity } = deps;
  const record = createRecorder(platform);
  const today = () => BusinessDate.today(clock).toString();
  const parseDate = (text: string) => BusinessDate.parse(text).toString();

  /** BR-5: the supervisor is an active user with the supervisor role. */
  const requireSupervisor = async (tx: Db, userId: string) => {
    const user = (await identity.users.list(tx)).find((candidate) => candidate.id === userId);
    assertSupervisor(user?.status === 'active' ? user : undefined);
  };

  /**
   * The team scopes of a supervisor follow their active teams, so access rules (spec section 6)
   * see the same teams as the team board.
   */
  const syncScopes = async (tx: Db, userId: string, actor: Actor) => {
    const user = (await identity.users.list(tx)).find((candidate) => candidate.id === userId);
    if (user === undefined) return;
    const wanted = (await listTeamsOfSupervisor(tx, userId)).filter((team) => team.active);
    const others = user.scopes.filter((scope) => scope.type !== 'team');
    const scopes: ScopeGrant[] = [
      ...others,
      ...wanted.map((team): ScopeGrant => ({ type: 'team', id: team.id })),
    ];
    const key = (scope: ScopeGrant) => `${scope.type}:${scope.id}`;
    const have = new Set(user.scopes.map(key));
    const want = new Set(scopes.map(key));
    if (have.size === want.size && [...want].every((entry) => have.has(entry))) return;
    await identity.users.setScopes(
      userId,
      scopes,
      user.version,
      { actorUserId: actor.userId, requestId: actor.requestId },
      tx,
    );
  };

  const detail = async (db: Db, row: TeamRow): Promise<TeamDetailDto> => ({
    ...teamOf(row),
    members: (await listMembersOn(db, row.id, today())).map(memberOf),
  });

  const membershipEvent = (
    teamId: string,
    date: string,
    added: readonly string[],
    removed: readonly string[],
  ) => ({ type: 'team.membership.changed', payload: { teamId, date, added, removed } });

  /**
   * BR-4: puts the worker into the team for the period. An open membership elsewhere ends the day
   * before.
   */
  const place = async (
    tx: Db,
    team: TeamRow,
    workerId: string,
    from: string,
    to: string | null,
    actor: Actor,
  ): Promise<void> => {
    const worker = assertFound(await findWorker(tx, workerId, true), 'worker');
    assertWorkerActive(worker.status);
    const memberships = await listMembershipsOfWorker(tx, workerId);
    const periods: Period[] = memberships.map((member) => ({
      id: periodId(member.team_id, member.from_date),
      from: member.from_date,
      to: member.to_date,
    }));
    const plan = planPeriodInsert(periods, { from, to }, 'membership_overlap');
    if (plan.close !== null) {
      const [otherTeamId, otherFrom] = plan.close.id.split('|') as [string, string];
      await setMemberEnd(tx, { teamId: otherTeamId, workerId, fromDate: otherFrom }, plan.close.to);
      await record(tx, actor, {
        action: 'workforce.team.member_ended',
        entityType: 'lab_team',
        entityId: otherTeamId,
        before: { workerId, fromDate: otherFrom, toDate: null },
        after: { workerId, fromDate: otherFrom, toDate: plan.close.to },
        event: membershipEvent(otherTeamId, from, [], [workerId]),
      });
    }
    await insertMember(
      tx,
      { teamId: team.id, workerId, fromDate: from, toDate: to },
      actor.userId,
      clock.now(),
    );
  };

  return {
    async create(input, actor, tx) {
      const name = input.name.trim();
      if (name === '') throw new ValidationError('team_name_required', 'The name is required');
      await requireSupervisor(tx, input.supervisorUserId);
      const code = textOrNull(input.code) ?? (await platform.numbering.next(teamSeries, tx));
      const row = await insertTeam(
        tx,
        { id: newId(), code, name, supervisor_user_id: input.supervisorUserId, active: true },
        actor.userId,
        clock.now(),
      );
      await syncScopes(tx, row.supervisor_user_id, actor);
      await record(tx, actor, {
        action: 'workforce.team.created',
        entityType: 'lab_team',
        entityId: row.id,
        after: teamOf(row),
        event: membershipEvent(row.id, today(), [], []),
      });
      return teamOf(row);
    },

    async update(id, patch, expectedVersion, actor, tx) {
      const before = assertFound(await findTeam(tx, id, true), 'team');
      const values: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name === '') throw new ValidationError('team_name_required', 'The name is required');
        values.name = name;
      }
      if (patch.supervisorUserId !== undefined) {
        await requireSupervisor(tx, patch.supervisorUserId);
        values.supervisor_user_id = patch.supervisorUserId;
      }
      if (patch.active !== undefined) values.active = patch.active;
      const row = assertUpdated(
        await updateTeam(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await syncScopes(tx, row.supervisor_user_id, actor);
      if (before.supervisor_user_id !== row.supervisor_user_id) {
        await syncScopes(tx, before.supervisor_user_id, actor);
      }
      await record(tx, actor, {
        action: 'workforce.team.updated',
        entityType: 'lab_team',
        entityId: id,
        before: teamOf(before),
        after: teamOf(row),
        event: membershipEvent(id, today(), [], []),
      });
      return teamOf(row);
    },

    async remove(id, expectedVersion, actor, tx) {
      const before = assertFound(await findTeam(tx, id, true), 'team');
      assertRemovable((await countMembers(tx, id)) > 0, 'team_in_use');
      const removed = await softDeleteTeam(tx, id, expectedVersion, actor.userId, clock.now());
      assertUpdated(removed ? true : undefined);
      await syncScopes(tx, before.supervisor_user_id, actor);
      await record(tx, actor, {
        action: 'workforce.team.removed',
        entityType: 'lab_team',
        entityId: id,
        before: teamOf(before),
        event: membershipEvent(id, today(), [], []),
      });
    },

    async get(db, id, actor) {
      const row = assertFound(await findTeam(db, id), 'team');
      assertTeamReachable(actor, id);
      return detail(db, row);
    },

    async list(db, actor) {
      return (await listTeams(db, teamLimit(actor))).map(teamOf);
    },

    async mine(db, actor) {
      const rows = (await listTeamsOfSupervisor(db, actor.userId)).filter((team) => team.active);
      return Promise.all(rows.map((row) => detail(db, row)));
    },

    async setMembers(id, input, expectedVersion, actor, tx) {
      const team = assertFound(await findTeam(tx, id, true), 'team');
      assertTeamReachable(actor, id);
      if (!team.active) {
        throw new RuleViolationError('team_inactive', 'The team is no longer active');
      }
      const date = input.date === undefined ? today() : parseDate(input.date);
      const wanted = new Set(input.workerIds);
      const current = await listMembersOn(tx, id, date);
      const currentIds = new Set(current.map((member) => member.worker_id));

      const removed = current.filter((member) => !wanted.has(member.worker_id));
      for (const member of removed) {
        const key = { teamId: id, workerId: member.worker_id, fromDate: member.from_date };
        if (member.from_date >= date) {
          // The membership only starts today or later, so there is no day to keep.
          await deleteMember(tx, key);
        } else {
          await setMemberEnd(tx, key, BusinessDate.parse(date).addDays(-1).toString());
        }
      }
      const added = [...wanted].filter((workerId) => !currentIds.has(workerId));
      for (const workerId of added) await place(tx, team, workerId, date, null, actor);

      const row = assertUpdated(
        await updateTeam(tx, id, expectedVersion, {}, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'workforce.team.members_changed',
        entityType: 'lab_team',
        entityId: id,
        before: { date, workerIds: [...currentIds].sort() },
        after: { date, workerIds: [...wanted].sort() },
        event: membershipEvent(
          id,
          date,
          added,
          removed.map((member) => member.worker_id),
        ),
      });
      return {
        ...teamOf(row),
        members: (await listMembersOn(tx, id, date)).map(memberOf),
      };
    },

    async addMembership(input, actor, tx) {
      const team = assertFound(await findTeam(tx, input.teamId, true), 'team');
      const from = parseDate(input.fromDate);
      const to = input.toDate == null ? null : parseDate(input.toDate);
      await place(tx, team, input.workerId, from, to, actor);
      await record(tx, actor, {
        action: 'workforce.team.member_added',
        entityType: 'lab_team',
        entityId: team.id,
        after: { workerId: input.workerId, fromDate: from, toDate: to },
        event: membershipEvent(team.id, from, [input.workerId], []),
      });
    },

    async getTeamMembers(db, teamId, date) {
      assertFound(await findTeam(db, teamId), 'team');
      return (await listMembersOn(db, teamId, parseDate(date))).map(memberOf);
    },

    async listTeamsForSupervisor(db, userId) {
      return (await listTeamsOfSupervisor(db, userId)).map(teamOf);
    },
  };
}
