import { ConflictError } from '@emporium/domain';
import { balanceOn, type AccountKind } from '@emporium/domain/cashbook';
import { BusinessDate } from '@emporium/domain/kernel';
import {
  assertAccountUnused,
  assertFound,
  assertMasked,
  assertOpeningBalance,
  assertOverdraftFlagAllowed,
  assertUpdated,
  normalizeTag,
} from '../policy/cashbook.policy.js';
import {
  countAccountTransactions,
  findAccount,
  findAccountByCode,
  insertAccount,
  listAccounts,
  listEntries,
  softDeleteAccount,
  updateAccount,
  type AccountRow,
} from '../repo/cashbook.repo.js';
import type { Actor, AccountDto, Db } from '../types.js';
import type { Context } from './context.js';
import { requiredText, textOrNull } from './support.js';

export interface AccountInput {
  code: string;
  name: string;
  kind: AccountKind;
  bankName?: string | undefined;
  accountNumberMasked?: string | undefined;
  accountCodeTag?: string | undefined;
  openingBalance: string;
  openingDate: string;
  allowOverdraft?: boolean | undefined;
}

export interface AccountPatch {
  name: string;
  bankName?: string | undefined;
  accountNumberMasked?: string | undefined;
  accountCodeTag?: string | undefined;
  allowOverdraft?: boolean | undefined;
  active?: boolean | undefined;
  version: number;
}

export interface AccountService {
  create(input: AccountInput, actor: Actor, tx: Db): Promise<AccountDto>;
  update(id: string, patch: AccountPatch, actor: Actor, tx: Db): Promise<AccountDto>;
  remove(id: string, version: number, actor: Actor, tx: Db): Promise<void>;
  get(db: Db, id: string): Promise<AccountDto>;
  list(db: Db, includeInactive: boolean): Promise<AccountDto[]>;
  /** BR-1: opening balance plus everything in, less everything out, on or before the date. */
  getBalance(db: Db, accountId: string, date: string): Promise<string>;
}

export const accountDto = (row: AccountRow, balance?: string): AccountDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind as AccountKind,
  bankName: row.bank_name,
  accountNumberMasked: row.account_number_masked,
  accountCodeTag: row.account_code_tag,
  openingBalance: row.opening_balance,
  openingDate: row.opening_date,
  allowOverdraft: row.allow_overdraft,
  active: row.active,
  version: row.version,
  ...(balance === undefined ? {} : { balance }),
});

export function createAccountService(ctx: Context): AccountService {
  const { newId, clock, record } = ctx;

  async function balanceNow(db: Db, row: AccountRow): Promise<string> {
    const entries = await listEntries(db, row.id);
    return balanceOn(row.opening_balance, entries, BusinessDate.today(clock).toString()).toString();
  }

  return {
    async create(input, actor, tx) {
      const code = requiredText(input.code, 'code');
      const allowOverdraft = input.allowOverdraft ?? false;
      assertOverdraftFlagAllowed(input.kind, allowOverdraft);
      assertOpeningBalance({
        kind: input.kind,
        allowOverdraft,
        openingBalance: input.openingBalance,
      });
      const masked = textOrNull(input.accountNumberMasked);
      assertMasked(masked);
      if ((await findAccountByCode(tx, code)) !== undefined) {
        throw new ConflictError('account_code_taken', 'An account with this code exists');
      }
      const row = await insertAccount(
        tx,
        {
          id: newId(),
          code,
          name: requiredText(input.name, 'name'),
          kind: input.kind,
          bank_name: textOrNull(input.bankName),
          account_number_masked: masked,
          account_code_tag: normalizeTag(input.accountCodeTag),
          opening_balance: input.openingBalance,
          opening_date: BusinessDate.parse(input.openingDate).toString(),
          allow_overdraft: allowOverdraft,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'cashbook.account.create',
        entityType: 'cbk_account',
        entityId: row.id,
        after: accountDto(row),
        event: { type: 'cashbook.account.changed', payload: { accountId: row.id } },
      });
      return accountDto(row, row.opening_balance);
    },

    async update(id, patch, actor, tx) {
      const before = assertFound(await findAccount(tx, id, true), 'account');
      const kind = before.kind as AccountKind;
      const allowOverdraft = patch.allowOverdraft ?? before.allow_overdraft;
      assertOverdraftFlagAllowed(kind, allowOverdraft);
      const masked = textOrNull(patch.accountNumberMasked);
      assertMasked(masked);
      // BR-1: the opening balance, its date and the kind are not part of an edit.
      const row = assertUpdated(
        await updateAccount(
          tx,
          id,
          patch.version,
          {
            name: requiredText(patch.name, 'name'),
            bank_name: textOrNull(patch.bankName),
            account_number_masked: masked,
            account_code_tag: normalizeTag(patch.accountCodeTag),
            allow_overdraft: allowOverdraft,
            active: patch.active ?? before.active,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'cashbook.account.update',
        entityType: 'cbk_account',
        entityId: id,
        before: accountDto(before),
        after: accountDto(row),
        event: { type: 'cashbook.account.changed', payload: { accountId: id } },
      });
      return accountDto(row, await balanceNow(tx, row));
    },

    async remove(id, version, actor, tx) {
      const before = assertFound(await findAccount(tx, id, true), 'account');
      assertAccountUnused(await countAccountTransactions(tx, id));
      assertUpdated(await softDeleteAccount(tx, id, version, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'cashbook.account.delete',
        entityType: 'cbk_account',
        entityId: id,
        before: accountDto(before),
        event: { type: 'cashbook.account.changed', payload: { accountId: id } },
      });
    },

    async get(db, id) {
      const row = assertFound(await findAccount(db, id), 'account');
      return accountDto(row, await balanceNow(db, row));
    },

    async list(db, includeInactive) {
      const rows = await listAccounts(db, includeInactive);
      return Promise.all(rows.map(async (row) => accountDto(row, await balanceNow(db, row))));
    },

    async getBalance(db, accountId, date) {
      const row = assertFound(await findAccount(db, accountId), 'account');
      const entries = await listEntries(db, accountId);
      return balanceOn(
        row.opening_balance,
        entries,
        BusinessDate.parse(date).toString(),
      ).toString();
    },
  };
}
