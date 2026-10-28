import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { custodianBalance, isBalanceZero } from '@emporium/domain/expenses';
import { platformPermissions } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Files } from '../../files/index.js';
import type { Identity } from '../../identity/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import { assertCostCodeActive, assertUpdated, assertUserKnown } from '../policy/expenses.policy.js';
import { listAdvancesOf, listCountedClaims, updateAdvance } from '../repo/expenses.repo.js';
import type { AdvanceStatus, ClaimStatus, Db } from '../types.js';
import { createRecorder } from './support.js';

export interface ExpensesDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'reverseCost' | 'transitionCost'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getCostCode'>;
  files: Pick<Files, 'list' | 'registerFileAccess'>;
  identity: Pick<Identity, 'users'>;
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder, dates and the balance. */
export function createContext(deps: ExpensesDeps) {
  const { platform, clock, newId, masterData, identity } = deps;
  const record = createRecorder(platform);

  /** BR-1: advances issued minus the approved and posted claims of the custodian. */
  async function balanceOf(db: Db, userId: string): Promise<string> {
    const advances = await listAdvancesOf(db, userId);
    const claims = await listCountedClaims(db, userId);
    return custodianBalance(
      advances.map((row) => ({ amount: row.amount, status: row.status as AdvanceStatus })),
      claims.map((row) => ({ total: row.total, status: row.status as ClaimStatus })),
    );
  }

  return {
    ...deps,
    record,
    newId,
    balanceOf,

    today: (): string => BusinessDate.today(clock).toString(),

    /** BR-2: a business date that is not in the future and within the backdating limit. */
    async checkDate(
      tx: Db,
      date: string,
      actor: { userId: string; permissions: ReadonlySet<string>; requestId: string | null },
      entityType: string,
    ): Promise<void> {
      await platform.backdating.check(
        {
          date: BusinessDate.parse(date),
          canOverride: actor.permissions.has(platformPermissions.backdateOverride),
          actorUserId: actor.userId,
          requestId: actor.requestId,
          entityType,
        },
        tx,
      );
    },

    async checkCostCode(tx: Db, costCodeId: string): Promise<void> {
      assertCostCodeActive((await masterData.getCostCode(tx, costCodeId)).active);
    },

    async checkUser(tx: Db, userId: string): Promise<void> {
      const users = await identity.users.list(tx);
      assertUserKnown(users.some((user) => user.id === userId && user.status === 'active'));
    },

    /**
     * BR-8: when the balance of a custodian has returned to zero their issued advances are settled.
     * Called after anything that changes the balance.
     */
    async settleIfZero(tx: Db, userId: string): Promise<void> {
      if (!isBalanceZero(await balanceOf(tx, userId))) return;
      const at = clock.now();
      for (const advance of (await listAdvancesOf(tx, userId)).filter(
        (a) => a.status === 'issued',
      )) {
        const row = assertUpdated(
          await updateAdvance(
            tx,
            advance.id,
            advance.version,
            { status: 'settled', settled_on: BusinessDate.fromInstant(at).toString() },
            null,
            at,
          ),
        );
        await record(
          tx,
          { userId: null, requestId: null },
          {
            action: 'expenses.advance.settle',
            entityType: 'exp_advance',
            entityId: advance.id,
            before: { status: advance.status },
            after: { status: row.status, by: 'balance returned to zero' },
            event: {
              type: 'expenses.advance.changed',
              payload: { advanceId: advance.id, custodianId: userId, status: 'settled' },
            },
          },
        );
      }
    },
  };
}
