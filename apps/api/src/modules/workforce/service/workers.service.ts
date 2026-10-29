import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { normalizeCnic, normalizePhone } from '@emporium/domain/masterdata';
import {
  assertCanDeactivate,
  assertRateAmount,
  assertWorkerIdentity,
  dailyEquivalent,
  maskLast4,
  periodAt,
  periodsToCloseAt,
  planPeriodInsert,
  type EmploymentType,
  type PayBasis,
  type Period,
  type UnapprovedSheet,
} from '@emporium/domain/workforce';
import { workerSeries, workforceSettingKeys, type WorkerStatus } from '@emporium/shared';
import type { Identity } from '../../identity/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertCnicFree,
  assertFound,
  assertRemovable,
  assertUpdated,
  assertWorkerActive,
  assertWorkerReachable,
  canSeeSensitive,
  teamLimit,
} from '../policy/workforce.policy.js';
import {
  countRates,
  countWorkersOfTrade,
  findActiveWorkerByCnic,
  findTrade,
  findWorker,
  insertRate,
  insertTrade,
  insertWorker,
  listMembershipsOfWorker,
  listRates,
  listTrades,
  searchWorkers,
  setMemberEnd,
  softDeleteWorker,
  teamIdsOfWorker,
  updateRate,
  updateTrade,
  updateWorker,
  type RateRow,
  type WorkerRow,
} from '../repo/workforce.repo.js';
import type {
  Actor,
  Db,
  PageResult,
  RateDto,
  TradeDto,
  WorkerDto,
  WorkerRateDto,
} from '../types.js';
import { createRecorder, textOrNull } from './support.js';

/** What the workforce module needs from attendance (P1-17); a fake stands in until it exists. */
export interface AttendanceQuery {
  /** BR-6: the attendance sheets of the worker, up to and including the date, not yet approved. */
  listUnapprovedSheets(db: Db, workerId: string, upTo: string): Promise<UnapprovedSheet[]>;
}

export interface WorkforceDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  identity: Pick<Identity, 'users'>;
  masterData: Pick<MasterData, 'getParty' | 'registerReferenceCheck'>;
  attendance: AttendanceQuery;
}

export interface WorkerFields {
  fullName: string;
  fatherName?: string | null | undefined;
  cnic?: string | null | undefined;
  phone?: string | null | undefined;
  tradeCode: string;
  employmentType: EmploymentType;
  contractorPartyId?: string | null | undefined;
  joinedOn: string;
  bankOrWalletInfo?: string | null | undefined;
}

export interface CreateWorkerInput extends WorkerFields {
  /** Taken from the worker number series when left out. */
  code?: string | undefined;
}

export type WorkerPatch = Partial<WorkerFields>;

export interface WorkerQuery {
  teamId?: string | undefined;
  tradeCode?: string | undefined;
  status?: WorkerStatus | undefined;
  text?: string | undefined;
  limit: number;
  offset: number;
}

export interface RateInput {
  payBasis: PayBasis;
  amount: string;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
}

export interface WorkersService {
  listTrades(db: Db): Promise<TradeDto[]>;
  createTrade(input: { code: string; name: string }, actor: Actor, tx: Db): Promise<TradeDto>;
  updateTrade(
    code: string,
    patch: { name: string },
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<TradeDto>;
  removeTrade(code: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;

  create(input: CreateWorkerInput, actor: Actor, tx: Db): Promise<WorkerDto>;
  update(
    id: string,
    patch: WorkerPatch,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<WorkerDto>;
  /** BR-6: the worker leaves; the open rate and team membership end on the leaving date. */
  deactivate(
    id: string,
    input: { leftOn: string },
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<WorkerDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** Module interface `getWorker`. */
  get(db: Db, id: string, actor: Actor): Promise<WorkerDto>;
  list(db: Db, query: WorkerQuery, actor: Actor): Promise<PageResult<WorkerDto>>;

  /** BR-2: a new rate; an open earlier rate ends the day before it starts. */
  addRate(workerId: string, input: RateInput, actor: Actor, tx: Db): Promise<RateDto>;
  listRates(db: Db, workerId: string): Promise<RateDto[]>;
  /** Module interface `getWorkerRate` (BR-3). */
  getWorkerRate(db: Db, workerId: string, date: string): Promise<WorkerRateDto>;
}

const rateOf = (row: RateRow): RateDto => ({
  id: row.id,
  workerId: row.worker_id,
  payBasis: row.pay_basis as PayBasis,
  amount: row.amount,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  setBy: row.set_by,
});

/** BR-8: the full CNIC and bank details only where `sensitive` is true. */
const workerOf = (row: WorkerRow, sensitive: boolean): WorkerDto => ({
  id: row.id,
  code: row.code,
  fullName: row.full_name,
  fatherName: row.father_name,
  cnic: sensitive ? row.cnic : maskLast4(row.cnic),
  phone: row.phone,
  tradeCode: row.trade_code,
  employmentType: row.employment_type as EmploymentType,
  contractorPartyId: row.contractor_party_id,
  joinedOn: row.joined_on,
  leftOn: row.left_on,
  status: row.status as WorkerStatus,
  bankOrWalletInfo: sensitive ? row.bank_or_wallet_info : maskLast4(row.bank_or_wallet_info),
  version: row.version,
});

const tradeOf = (row: { code: string; name: string; version: number }): TradeDto => ({
  code: row.code,
  name: row.name,
  version: row.version,
});

const parseDate = (text: string): string => BusinessDate.parse(text).toString();

export function createWorkersService(deps: WorkforceDeps): WorkersService {
  const { platform, clock, newId, masterData, attendance } = deps;
  const record = createRecorder(platform);
  const today = () => BusinessDate.today(clock).toString();

  const changed = (row: WorkerRow, change: string) => ({
    type: 'worker.changed',
    payload: { workerId: row.id, change },
  });

  /** A labour contractor of the master data (BR-1's contractor exception). */
  const assertContractor = async (db: Db, id: string | null) => {
    if (id === null) return;
    const party = await masterData.getParty(db, id);
    if (party === undefined || !party.roles.includes('labour_contractor')) {
      throw new ValidationError('contractor_invalid', 'The contractor must be a labour contractor');
    }
  };

  const assertTrade = async (db: Db, code: string) => {
    if ((await findTrade(db, code)) === undefined) {
      throw new ValidationError('trade_unknown', `The trade ${code} does not exist`);
    }
  };

  /** Cleans the text fields and checks the rules that need only the worker itself (BR-1, BR-8). */
  const prepare = (fields: WorkerFields) => {
    const cnicText = textOrNull(fields.cnic);
    const phoneText = textOrNull(fields.phone);
    const prepared = {
      full_name: fields.fullName.trim(),
      father_name: textOrNull(fields.fatherName),
      cnic: cnicText === null ? null : normalizeCnic(cnicText),
      phone: phoneText === null ? null : normalizePhone(phoneText),
      trade_code: fields.tradeCode,
      employment_type: fields.employmentType,
      contractor_party_id: fields.contractorPartyId ?? null,
      joined_on: parseDate(fields.joinedOn),
      bank_or_wallet_info: textOrNull(fields.bankOrWalletInfo),
    };
    if (prepared.full_name === '') {
      throw new ValidationError('full_name_required', 'The name is required');
    }
    assertWorkerIdentity({
      employmentType: fields.employmentType,
      cnic: prepared.cnic,
      contractorPartyId: prepared.contractor_party_id,
    });
    return prepared;
  };

  const fieldsOf = (row: WorkerRow): WorkerFields => ({
    fullName: row.full_name,
    fatherName: row.father_name,
    cnic: row.cnic,
    phone: row.phone,
    tradeCode: row.trade_code,
    employmentType: row.employment_type as EmploymentType,
    contractorPartyId: row.contractor_party_id,
    joinedOn: row.joined_on,
    bankOrWalletInfo: row.bank_or_wallet_info,
  });

  const lockedWorker = async (tx: Db, id: string) =>
    assertFound(await findWorker(tx, id, true), 'worker');

  const service: WorkersService = {
    listTrades: async (db) => (await listTrades(db)).map(tradeOf),

    async createTrade(input, actor, tx) {
      const code = input.code.trim().toLowerCase();
      if (!/^[a-z0-9_]+$/.test(code)) {
        throw new ValidationError('trade_code_invalid', 'Use lower-case letters, digits and _');
      }
      const name = input.name.trim();
      if (name === '') throw new ValidationError('trade_name_required', 'The name is required');
      if ((await findTrade(tx, code)) !== undefined) {
        throw new RuleViolationError('trade_exists', `The trade ${code} already exists`);
      }
      const row = await insertTrade(tx, code, name, actor.userId, clock.now());
      await record(tx, actor, {
        action: 'workforce.trade.created',
        entityType: 'lab_trade',
        entityId: code,
        after: tradeOf(row),
        event: { type: 'worker.changed', payload: { trade: code, change: 'trade' } },
      });
      return tradeOf(row);
    },

    async updateTrade(code, patch, expectedVersion, actor, tx) {
      const before = assertFound(await findTrade(tx, code), 'trade');
      const name = patch.name.trim();
      if (name === '') throw new ValidationError('trade_name_required', 'The name is required');
      const row = assertUpdated(
        await updateTrade(tx, code, expectedVersion, { name }, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'workforce.trade.updated',
        entityType: 'lab_trade',
        entityId: code,
        before: tradeOf(before),
        after: tradeOf(row),
        event: { type: 'worker.changed', payload: { trade: code, change: 'trade' } },
      });
      return tradeOf(row);
    },

    async removeTrade(code, expectedVersion, actor, tx) {
      const before = assertFound(await findTrade(tx, code), 'trade');
      assertRemovable((await countWorkersOfTrade(tx, code)) > 0, 'trade_in_use');
      assertUpdated(
        await updateTrade(
          tx,
          code,
          expectedVersion,
          { deleted_at: clock.now().toISOString() },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'workforce.trade.removed',
        entityType: 'lab_trade',
        entityId: code,
        before: tradeOf(before),
        event: { type: 'worker.changed', payload: { trade: code, change: 'trade' } },
      });
    },

    async create(input, actor, tx) {
      const prepared = prepare(input);
      await assertTrade(tx, prepared.trade_code);
      await assertContractor(tx, prepared.contractor_party_id);
      assertCnicFree(
        prepared.cnic === null ? undefined : (await findActiveWorkerByCnic(tx, prepared.cnic))?.id,
        undefined,
      );
      const code = textOrNull(input.code) ?? (await platform.numbering.next(workerSeries, tx));
      const row = await insertWorker(
        tx,
        { id: newId(), code, ...prepared, status: 'active' },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'workforce.worker.created',
        entityType: 'lab_worker',
        entityId: row.id,
        after: workerOf(row, false),
        event: changed(row, 'created'),
      });
      return workerOf(row, canSeeSensitive(actor));
    },

    async update(id, patch, expectedVersion, actor, tx) {
      const before = await lockedWorker(tx, id);
      const prepared = prepare({ ...fieldsOf(before), ...patch });
      await assertTrade(tx, prepared.trade_code);
      await assertContractor(tx, prepared.contractor_party_id);
      if (before.status === 'active' && prepared.cnic !== null) {
        assertCnicFree((await findActiveWorkerByCnic(tx, prepared.cnic))?.id, id);
      }
      const row = assertUpdated(
        await updateWorker(tx, id, expectedVersion, prepared, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'workforce.worker.updated',
        entityType: 'lab_worker',
        entityId: id,
        before: workerOf(before, false),
        after: workerOf(row, false),
        event: changed(row, 'updated'),
      });
      return workerOf(row, canSeeSensitive(actor));
    },

    async deactivate(id, input, expectedVersion, actor, tx) {
      const before = await lockedWorker(tx, id);
      assertWorkerActive(before.status);
      const leftOn = parseDate(input.leftOn);
      if (leftOn < before.joined_on) {
        throw new ValidationError('left_on_before_joined', 'The leaving date precedes joining');
      }
      assertCanDeactivate(leftOn, await attendance.listUnapprovedSheets(tx, id, leftOn));

      const rates = await listRates(tx, id);
      const allMemberships = await listMembershipsOfWorker(tx, id);
      const rateIds = periodsToCloseAt(
        rates.map((rate) => ({
          id: rate.id,
          from: rate.effective_from,
          to: rate.effective_to,
        })),
        leftOn,
        'rate_starts_after_leaving',
      );
      const memberIds = periodsToCloseAt(
        allMemberships.map((member): Period => ({
          id: `${member.team_id}|${member.from_date}`,
          from: member.from_date,
          to: member.to_date,
        })),
        leftOn,
        'membership_starts_after_leaving',
      );

      for (const rateId of rateIds) {
        const rate = rates.find((candidate) => candidate.id === rateId) as RateRow;
        const closed = assertUpdated(
          await updateRate(
            tx,
            rate.id,
            rate.version,
            { effective_to: leftOn },
            actor.userId,
            clock.now(),
          ),
        );
        await record(tx, actor, {
          action: 'workforce.rate.closed',
          entityType: 'lab_pay_rate',
          entityId: rate.id,
          before: rateOf(rate),
          after: rateOf(closed),
          event: changed(before, 'rate'),
        });
      }
      for (const memberId of memberIds) {
        const [teamId, fromDate] = memberId.split('|') as [string, string];
        await setMemberEnd(tx, { teamId, workerId: id, fromDate }, leftOn);
        await record(tx, actor, {
          action: 'workforce.team.member_ended',
          entityType: 'lab_team',
          entityId: teamId,
          before: { workerId: id, fromDate, toDate: null },
          after: { workerId: id, fromDate, toDate: leftOn },
          event: {
            type: 'team.membership.changed',
            payload: { teamId, date: leftOn, added: [], removed: [id] },
          },
        });
      }

      const row = assertUpdated(
        await updateWorker(
          tx,
          id,
          expectedVersion,
          { status: 'inactive', left_on: leftOn },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'workforce.worker.deactivated',
        entityType: 'lab_worker',
        entityId: id,
        before: workerOf(before, false),
        after: workerOf(row, false),
        event: changed(row, 'deactivated'),
      });
      return workerOf(row, canSeeSensitive(actor));
    },

    async remove(id, expectedVersion, actor, tx) {
      const before = await lockedWorker(tx, id);
      const inUse =
        (await countRates(tx, id)) > 0 || (await listMembershipsOfWorker(tx, id)).length > 0;
      assertRemovable(inUse, 'worker_in_use');
      const removed = await softDeleteWorker(tx, id, expectedVersion, actor.userId, clock.now());
      assertUpdated(removed ? true : undefined);
      await record(tx, actor, {
        action: 'workforce.worker.removed',
        entityType: 'lab_worker',
        entityId: id,
        before: workerOf(before, false),
        event: changed(before, 'removed'),
      });
    },

    async get(db, id, actor) {
      const row = assertFound(await findWorker(db, id), 'worker');
      assertWorkerReachable(actor, await teamIdsOfWorker(db, id, today()));
      return workerOf(row, canSeeSensitive(actor));
    },

    async list(db, query, actor) {
      const { rows, total } = await searchWorkers(db, {
        teamIds: teamLimit(actor),
        asOf: today(),
        teamId: query.teamId,
        tradeCode: query.tradeCode,
        status: query.status,
        text: textOrNull(query.text) ?? undefined,
        limit: query.limit,
        offset: query.offset,
      });
      return {
        items: rows.map((row) => workerOf(row, false)),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async addRate(workerId, input, actor, tx) {
      const worker = await lockedWorker(tx, workerId);
      assertWorkerActive(worker.status);
      const amount = assertRateAmount(input.amount);
      const effectiveFrom = parseDate(input.effectiveFrom);
      const effectiveTo = input.effectiveTo == null ? null : parseDate(input.effectiveTo);
      const existing = await listRates(tx, workerId);
      const plan = planPeriodInsert(
        existing.map((rate) => ({ id: rate.id, from: rate.effective_from, to: rate.effective_to })),
        { from: effectiveFrom, to: effectiveTo },
        'rate_overlap',
      );
      if (plan.close !== null) {
        const open = existing.find((rate) => rate.id === plan.close?.id) as RateRow;
        const closed = assertUpdated(
          await updateRate(
            tx,
            open.id,
            open.version,
            { effective_to: plan.close.to },
            actor.userId,
            clock.now(),
          ),
        );
        await record(tx, actor, {
          action: 'workforce.rate.closed',
          entityType: 'lab_pay_rate',
          entityId: open.id,
          before: rateOf(open),
          after: rateOf(closed),
          event: changed(worker, 'rate'),
        });
      }
      const row = await insertRate(
        tx,
        {
          id: newId(),
          worker_id: workerId,
          pay_basis: input.payBasis,
          amount,
          effective_from: effectiveFrom,
          effective_to: effectiveTo,
          set_by: actor.userId,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'workforce.rate.added',
        entityType: 'lab_pay_rate',
        entityId: row.id,
        after: rateOf(row),
        event: changed(worker, 'rate'),
      });
      return rateOf(row);
    },

    async listRates(db, workerId) {
      assertFound(await findWorker(db, workerId), 'worker');
      return (await listRates(db, workerId)).map(rateOf);
    },

    async getWorkerRate(db, workerId, date) {
      assertFound(await findWorker(db, workerId), 'worker');
      const day = parseDate(date);
      const rates = (await listRates(db, workerId)).map((rate) => ({
        ...rate,
        from: rate.effective_from,
        to: rate.effective_to,
      }));
      const rate = periodAt(rates, day);
      if (rate === undefined) {
        throw new NotFoundError('rate_not_found', `No pay rate is in effect on ${day}`);
      }
      const basis = Number(
        (await platform.settings.get(db, workforceSettingKeys.workingDaysBasis)).value,
      );
      const payBasis = rate.pay_basis as PayBasis;
      return {
        workerId,
        date: day,
        payBasis,
        amount: rate.amount,
        dailyEquivalent: dailyEquivalent({ payBasis, amount: rate.amount }, basis),
        effectiveFrom: rate.effective_from,
        effectiveTo: rate.effective_to,
      };
    },
  };

  // BR-1: a labour contractor that still has workers cannot be removed from the master data.
  masterData.registerReferenceCheck('party', async (db, id) => {
    const rows = await db.query<{ n: string }>(
      'select count(*) as n from lab_workers where contractor_party_id = $1 and deleted_at is null',
      [id],
    );
    return Number((rows[0] as { n: string }).n) > 0;
  });

  return service;
}
