import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { assertAdvance, money } from '@emporium/domain/wages';
import type { WageAdvanceStatus } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { Workforce } from '../../workforce/index.js';
import {
  insertAdvance,
  searchAdvances,
  sumAdvanceBalance,
  type AdvanceRow,
} from '../repo/wages.repo.js';
import type { Actor, AdvanceDto, Db, PageResult } from '../types.js';
import { createRecorder } from './support.js';

export interface AdvancesDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  workforce: Pick<Workforce, 'getWorker'>;
}

export interface AdvanceInput {
  workerId: string;
  amount: string;
  issuedOn: string;
  monthlyRecovery: string;
  note?: string | null | undefined;
}

export interface AdvanceQuery {
  workerId?: string | undefined;
  status?: WageAdvanceStatus | undefined;
  limit: number;
  offset: number;
}

export type AdvancesService = ReturnType<typeof createAdvancesService>;

export function createAdvancesService(deps: AdvancesDeps) {
  const { platform, clock, newId, workforce } = deps;
  const record = createRecorder(platform);

  const advanceOf = (row: AdvanceRow, worker: { code: string; fullName: string }): AdvanceDto => ({
    id: row.id,
    workerId: row.worker_id,
    workerCode: worker.code,
    workerName: worker.fullName,
    amount: row.amount,
    issuedOn: row.issued_on,
    monthlyRecovery: row.monthly_recovery,
    balance: row.balance,
    status: row.status as WageAdvanceStatus,
    note: row.note,
    version: row.version,
  });

  return {
    /** `POST /wages/advances`: a simple advance repaid in monthly instalments from the wage sheet. */
    async create(input: AdvanceInput, actor: Actor, tx: Db): Promise<AdvanceDto> {
      const worker = await workforce.getWorker(tx, input.workerId, actor);
      const { amount, monthlyRecovery } = assertAdvance(input);
      const note = input.note?.trim();
      const row = await insertAdvance(
        tx,
        {
          id: newId(),
          worker_id: input.workerId,
          amount,
          issued_on: BusinessDate.parse(input.issuedOn).toString(),
          monthly_recovery: monthlyRecovery,
          status: 'open',
          note: note === undefined || note === '' ? null : note,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'wages.advance.create',
        entityType: 'wag_advance',
        entityId: row.id,
        after: { workerId: row.worker_id, amount, monthlyRecovery },
        event: {
          type: 'wages.advance.changed',
          payload: { advanceId: row.id, workerId: row.worker_id, amount, change: 'create' },
        },
      });
      return advanceOf(row, worker);
    },

    /** `GET /wages/advances`; the worker's name is looked up for the rows of the page. */
    async list(db: Db, query: AdvanceQuery, actor: Actor): Promise<PageResult<AdvanceDto>> {
      const { rows, total } = await searchAdvances(db, query);
      const items: AdvanceDto[] = [];
      for (const row of rows) {
        items.push(advanceOf(row, await workforce.getWorker(db, row.worker_id, actor)));
      }
      return { items, total, limit: query.limit, offset: query.offset };
    },

    /**
     * Module interface `getWorkerAdvanceBalance(workerId)`: what the worker still owes on open
     * advances. Balances move only when a wage period is approved (BR-6).
     */
    async getWorkerAdvanceBalance(db: Db, workerId: string): Promise<string> {
      return money(await sumAdvanceBalance(db, workerId));
    },
  };
}
