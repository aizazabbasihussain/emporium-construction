import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  assertNegativeStockOff,
  assertSufficient,
  directionOf,
  reorderState,
} from '@emporium/domain/inventory';
import { D, fmtQty, fmtRate } from '@emporium/domain/valuation';
import { inventorySettingKeys } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Notifications } from '../../notifications/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Valuation } from '../../valuation/index.js';
import {
  findLedgerByKey,
  findStore,
  insertLedger,
  lockBalance,
  lockReorderLevel,
  setBalance,
  setReorderAlerted,
  type LedgerRow,
} from '../repo/inventory.repo.js';
import { assertFound } from '../policy/inventory.policy.js';
import type { Db } from '../types.js';
import { createRecorder } from './support.js';

export interface InventoryDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  valuation: Pick<
    Valuation,
    'recordReceipt' | 'valueIssue' | 'recordTransfer' | 'recordReturn' | 'getStockValue'
  >;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'reverseCost'>;
  masterData: Pick<MasterData, 'getItem' | 'getParty'>;
  approvals: Pick<Approvals, 'requestApproval'>;
  notifications: Pick<Notifications, 'notifyRole' | 'registerTemplate'>;
}

/** What one movement needs; the quantity is positive and the type gives it its sign. */
export interface Movement {
  storeId: string;
  itemId: string;
  ownership: 'company' | 'client';
  ownerPartyId: string | null;
  type: string;
  quantity: string;
  unitCost?: string | null;
  value?: string | null;
  costObject?: { type: string; id: string | null } | null;
  source: { type: string; id: string; lineId?: string | null };
  businessDate: string;
  key: string;
  by: string | null;
  reversesId?: string | null;
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder, settings and the movement poster. */
export function createContext(deps: InventoryDeps) {
  const { platform, clock, newId, masterData, notifications } = deps;
  const record = createRecorder(platform);

  /** BR-10: one alert per crossing, sent to the storekeepers and procurement. */
  async function checkReorder(tx: Db, storeId: string, itemId: string, balance: string) {
    const level = await lockReorderLevel(tx, storeId, itemId);
    if (level === undefined) return;
    const state = reorderState(balance, level.level, level.alerted);
    if (state.alerted !== level.alerted)
      await setReorderAlerted(tx, storeId, itemId, state.alerted);
    if (!state.alert) return;
    const store = assertFound(await findStore(tx, storeId), 'store');
    const item = await masterData.getItem(tx, itemId);
    const data = {
      storeCode: store.code,
      itemCode: (item as NonNullable<typeof item>).code,
      quantity: fmtQty(new D(balance)),
      level: fmtQty(new D(level.level)),
    };
    await notifications.notifyRole('storekeeper', 'inventory.reorder.low', data, tx);
    await notifications.notifyRole('procurement', 'inventory.reorder.low', data, tx);
  }

  return {
    ...deps,
    record,
    newId,

    today: (): string => BusinessDate.today(clock).toString(),

    /** The business date of a command: not in the future, within the backdating limit (BR-9). */
    async checkDate(
      tx: Db,
      date: string,
      actor: { userId: string; permissions: ReadonlySet<string>; requestId: string | null },
      entityType: string,
      reason?: string,
    ): Promise<string> {
      const parsed = BusinessDate.parse(date);
      await platform.backdating.check(
        {
          date: parsed,
          canOverride: actor.permissions.has('platform.backdate.override'),
          reason,
          actorUserId: actor.userId,
          requestId: actor.requestId,
          entityType,
        },
        tx,
      );
      return parsed.toString();
    },

    async setting(tx: Db, key: string): Promise<unknown> {
      return (await platform.settings.get(tx, key)).value;
    },

    /** BR-1: only `false` is accepted for `allow_negative_stock`. */
    async assertNoNegativeStock(tx: Db): Promise<void> {
      assertNegativeStockOff(
        (await platform.settings.get(tx, inventorySettingKeys.allowNegativeStock)).value === true,
      );
    },

    /**
     * BR-1: checks the balance before valuation is asked, so a shortfall is reported in stock
     * quantities. The balance row stays locked for the rest of the transaction (BR-11).
     */
    async assertAvailable(
      tx: Db,
      key: { storeId: string; itemId: string; ownership: string; ownerPartyId: string | null },
      quantity: string,
    ): Promise<void> {
      const balance = await lockBalance(tx, newId(), key, clock.now());
      assertSufficient(balance.quantity, quantity);
    },

    /**
     * Posts one ledger row and moves the balance under its lock (BR-11). A repeat of the same
     * idempotency key returns the row that exists and changes nothing.
     */
    async post(tx: Db, movement: Movement): Promise<{ row: LedgerRow; repeated: boolean }> {
      const repeat = await findLedgerByKey(tx, movement.key);
      if (repeat !== undefined) return { row: repeat, repeated: true };
      const now = clock.now();
      const balance = await lockBalance(
        tx,
        newId(),
        {
          storeId: movement.storeId,
          itemId: movement.itemId,
          ownership: movement.ownership,
          ownerPartyId: movement.ownerPartyId,
        },
        now,
      );
      const sign = directionOf(movement.type);
      if (sign === -1) assertSufficient(balance.quantity, movement.quantity);
      const next = fmtQty(
        new D(balance.quantity).plus(
          sign === 1 ? movement.quantity : new D(movement.quantity).negated(),
        ),
      );
      const row = await insertLedger(tx, {
        id: newId(),
        storeId: movement.storeId,
        itemId: movement.itemId,
        ownership: movement.ownership,
        ownerPartyId: movement.ownerPartyId,
        movementType: movement.type,
        quantity:
          sign === 1
            ? fmtQty(new D(movement.quantity))
            : fmtQty(new D(movement.quantity).negated()),
        unitCost:
          movement.unitCost === null || movement.unitCost === undefined
            ? null
            : fmtRate(new D(movement.unitCost)),
        value: movement.value ?? null,
        costObjectType: movement.costObject?.type ?? null,
        costObjectId: movement.costObject?.id ?? null,
        sourceDocType: movement.source.type,
        sourceDocId: movement.source.id,
        sourceLineId: movement.source.lineId ?? null,
        businessDate: movement.businessDate,
        postedAt: now,
        idempotencyKey: movement.key,
        reversesId: movement.reversesId ?? null,
        createdBy: movement.by,
      });
      await setBalance(tx, balance.id, next, now);
      if (movement.ownership === 'company')
        await checkReorder(tx, movement.storeId, movement.itemId, next);
      return { row, repeated: false };
    },
  };
}
