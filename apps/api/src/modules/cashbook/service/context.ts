import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { platformPermissions } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Platform } from '../../platform/index.js';
import type { Db } from '../types.js';
import { createRecorder } from './support.js';

export interface CashbookDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder and the business date rules. */
export function createContext(deps: CashbookDeps) {
  const { platform, clock } = deps;
  return {
    ...deps,
    record: createRecorder(platform),
    today: (): string => BusinessDate.today(clock).toString(),

    /** BR-10: a business date that is not in the future and within the backdating limit. */
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
  };
}
