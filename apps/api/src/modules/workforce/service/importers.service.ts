import { ValidationError } from '@emporium/domain';
import type { ColumnDef } from '@emporium/domain/importer';
import { employmentTypes, payBases } from '@emporium/shared';
import { z } from 'zod';
import type { ApplyContext, ImporterDefinition } from '../../importer/index.js';
import { findTeamByCode, findWorkerByCode } from '../repo/workforce.repo.js';
import type { Actor, Db } from '../types.js';
import type { TeamsService } from './teams.service.js';
import type { WorkforceDeps, WorkersService } from './workers.service.js';

export type RegisterImporter = <T>(definition: ImporterDefinition<T>) => void;

const text = (name: string, example: string, required = false, note?: string): ColumnDef => ({
  name,
  type: 'text',
  required,
  example,
  maxLength: 500,
  ...(note === undefined ? {} : { note }),
});

const choice = (
  name: string,
  allowed: readonly string[],
  example: string,
  required = false,
): ColumnDef => ({ name, type: 'enum', required, example, allowed });

const optionalText = z.string().nullable();

/** An import runs as the person who started it, with the services' own checks (BR-9). */
const actorOf = (ctx: ApplyContext): Actor => ({
  userId: ctx.actorUserId,
  roles: [],
  scopes: [],
  permissions: new Set<string>(),
  requestId: ctx.requestId,
});

/** A referenced code that is not loaded yet is a row problem, not a crash. */
function requireFound<T>(row: T | undefined, what: string, code: string): T {
  if (row === undefined) {
    throw new ValidationError(`${what}_unknown`, `${what} ${code} does not exist`);
  }
  return row;
}

const workerSchema = z.object({
  code: z.string(),
  full_name: z.string(),
  father_name: optionalText,
  cnic: optionalText,
  phone: optionalText,
  trade: z.string(),
  employment_type: z.enum(employmentTypes),
  joined_on: z.string(),
  bank_or_wallet_info: optionalText,
});

const rateSchema = z.object({
  worker_code: z.string(),
  pay_basis: z.enum(payBases),
  amount: z.string(),
  effective_from: z.string(),
  effective_to: optionalText,
});

const teamSchema = z.object({
  code: z.string(),
  name: z.string(),
  supervisor_email: z.string(),
});

const memberSchema = z.object({
  team_code: z.string(),
  worker_code: z.string(),
  from_date: z.string(),
  to_date: optionalText,
});

/**
 * BR-9: one importer for each of workers, pay rates, teams and team memberships. Every row goes
 * through the same service as the API, so the same rules apply. Contractor labour is not loaded
 * as workers (H-12), so there is no contractor column.
 */
export function registerWorkforceImporters(
  register: RegisterImporter,
  services: {
    workers: WorkersService;
    teams: TeamsService;
    identity: WorkforceDeps['identity'];
  },
): void {
  const { workers, teams, identity } = services;

  const workerByCode = async (db: Db, code: string) =>
    requireFound(await findWorkerByCode(db, code), 'worker', code);

  register({
    code: 'workers',
    label: 'Workers',
    schema: workerSchema,
    columns: [
      text('code', 'WK-0001', true, 'The worker code; rates and teams refer to it'),
      text('full_name', 'Example Worker', true),
      text('father_name', 'Example Father'),
      text('cnic', '35202-1234567-1', false, 'Required for permanent and daily workers'),
      text('phone', '0300 1234567'),
      text('trade', 'mason', true, 'A trade code, for example mason or helper'),
      choice('employment_type', employmentTypes, 'daily', true),
      { name: 'joined_on', type: 'date', required: true, example: '2026-01-01' },
      text('bank_or_wallet_info', ''),
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        await workers.create(
          {
            code: row.code,
            fullName: row.full_name,
            fatherName: row.father_name,
            cnic: row.cnic,
            phone: row.phone,
            tradeCode: row.trade,
            employmentType: row.employment_type,
            joinedOn: row.joined_on,
            bankOrWalletInfo: row.bank_or_wallet_info,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'worker_pay_rates',
    label: 'Worker pay rates',
    schema: rateSchema,
    dependsOn: ['workers'],
    columns: [
      text('worker_code', 'WK-0001', true, 'Import workers first'),
      choice('pay_basis', payBases, 'daily_rate', true),
      { name: 'amount', type: 'decimal', required: true, example: '1000.00' },
      { name: 'effective_from', type: 'date', required: true, example: '2026-01-01' },
      {
        name: 'effective_to',
        type: 'date',
        required: false,
        example: '',
        note: 'Empty for the rate that is in force now',
      },
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        const worker = await workerByCode(tx, row.worker_code);
        await workers.addRate(
          worker.id,
          {
            payBasis: row.pay_basis,
            amount: row.amount,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'teams',
    label: 'Teams',
    schema: teamSchema,
    columns: [
      text('code', 'TM-001', true),
      text('name', 'Block A masonry team', true),
      text('supervisor_email', 'supervisor@example.test', true, 'A user with the supervisor role'),
    ],
    async apply(rows, ctx, tx) {
      const users = await identity.users.list(tx);
      for (const row of rows) {
        const email = row.supervisor_email.trim().toLowerCase();
        const supervisor = requireFound(
          users.find((user) => user.email.toLowerCase() === email),
          'supervisor',
          row.supervisor_email,
        );
        await teams.create(
          { code: row.code, name: row.name, supervisorUserId: supervisor.id },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'team_members',
    label: 'Team memberships',
    schema: memberSchema,
    dependsOn: ['workers', 'teams'],
    columns: [
      text('team_code', 'TM-001', true),
      text('worker_code', 'WK-0001', true),
      { name: 'from_date', type: 'date', required: true, example: '2026-01-01' },
      {
        name: 'to_date',
        type: 'date',
        required: false,
        example: '',
        note: 'Empty while the worker is still in the team',
      },
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        const team = requireFound(await findTeamByCode(tx, row.team_code), 'team', row.team_code);
        const worker = await workerByCode(tx, row.worker_code);
        await teams.addMembership(
          { teamId: team.id, workerId: worker.id, fromDate: row.from_date, toDate: row.to_date },
          actorOf(ctx),
          tx,
        );
      }
    },
  });
}
