import { ValidationError } from '@emporium/domain';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { platformPermissions } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Cashbook } from '../../cashbook/index.js';
import type { Inventory } from '../../inventory/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Procurement } from '../../procurement/index.js';
import type { Projects } from '../../projects/index.js';
import type { Tax } from '../../tax/index.js';
import type { Actor, CostObjectRef, Db } from '../types.js';

export interface PayablesDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  procurement: Pick<Procurement, 'getGrn' | 'getPurchaseOrder' | 'listOpenPoLines'>;
  inventory: Pick<Inventory, 'hasIssuesFromGrn'>;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'transitionCost' | 'reverseCost'>;
  tax: Pick<Tax, 'calculateSalesTax' | 'calculateWithholding' | 'registerReportSource'>;
  cashbook: Pick<Cashbook, 'recordPayment' | 'transactions'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getParty' | 'getCostCode' | 'costing'>;
}

export type Context = ReturnType<typeof createContext>;

export interface Recorded {
  userId: string | null;
  requestId: string | null;
}

export interface Change {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Published to the outbox in the same transaction (constitution 5.9). */
  event: { type: string; payload: unknown };
}

/** Empty text becomes null; other text is trimmed. */
export const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export function requiredText(value: string | null | undefined, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new ValidationError(`${field}_required`, `${field} is required`);
  return text;
}

/**
 * The user of module-to-module reads that are not limited to one user's projects. A bill source
 * provider (P2-06) builds its lines with it.
 */
export const readerActor = {
  userId: '00000000-0000-0000-0000-000000000000',
  roles: ['admin'],
  scopes: [],
  permissions: new Set<string>(),
  requestId: null,
} as const;

export const overheadObject: CostObjectRef = { type: 'overhead', id: null };

/** What every sub-service shares: the dependencies, the recorder and the business date rules. */
export function createContext(deps: PayablesDeps) {
  const { platform, clock } = deps;
  return {
    ...deps,
    today: (): string => BusinessDate.today(clock).toString(),

    /** Every change writes an audit entry and an event (constitution 5.9, 5.12). */
    async record(tx: Db, actor: Recorded, change: Change): Promise<void> {
      await platform.audit.record(
        {
          actorUserId: actor.userId,
          action: change.action,
          entityType: change.entityType,
          entityId: change.entityId,
          before: change.before,
          after: change.after,
          requestId: actor.requestId,
        },
        tx,
      );
      await platform.events.publish(change.event, tx);
    },

    /** A business date that is not in the future and within the backdating limit. */
    async checkDate(tx: Db, date: string, actor: Actor, entityType: string): Promise<void> {
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

    async setting(db: Db, key: string): Promise<string> {
      return String((await platform.settings.get(db, key)).value);
    },
  };
}
