import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { documentNumber } from '@emporium/domain/procurement';
import type { Approvals } from '../../approvals/index.js';
import type { Files } from '../../files/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import {
  assertCostCodeActive,
  assertItemActive,
  assertKnown,
  assertVendor,
} from '../policy/procurement.policy.js';
import { nextSeq } from '../repo/procurement.repo.js';
import type { Db } from '../types.js';
import { createRecorder } from './support.js';

/**
 * What the module asks of inventory and payables before a receipt is cancelled (BR-8). Those
 * modules do not exist yet; until they are wired, nothing has been issued or billed.
 */
export interface GrnGuards {
  isIssued(db: Db, grnId: string): Promise<boolean>;
  isBilled(db: Db, grnId: string): Promise<boolean>;
}

export const noGuards: GrnGuards = {
  isIssued: async () => false,
  isBilled: async () => false,
};

export interface ProcurementDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'reverseCost'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getParty' | 'getItem' | 'getCostCode'>;
  files: Pick<Files, 'list' | 'attach' | 'registerFileAccess'>;
  guards: GrnGuards;
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder and the reference checks. */
export function createContext(deps: ProcurementDeps) {
  const { platform, clock, newId, masterData } = deps;
  return {
    ...deps,
    record: createRecorder(platform),

    /** Numbers of this module run per kind and year: `REQ-2026-0001`. */
    async numberFor(tx: Db, kind: 'requisition' | 'rfq' | 'grn', prefix: string): Promise<string> {
      const year = BusinessDate.today(clock).year;
      return documentNumber(prefix, year, await nextSeq(tx, kind, year));
    },

    /** BR-10: the line's item exists and is active; the unit defaults to the item's unit. */
    async lineItem(tx: Db, itemId: string): Promise<{ unitCode: string }> {
      const item = await masterData.getItem(tx, itemId);
      assertKnown(item !== undefined, 'item_not_found', 'An item on a line does not exist');
      assertItemActive((item as { active: boolean }).active);
      return item as { unitCode: string };
    },

    async checkCostCode(tx: Db, costCodeId: string): Promise<void> {
      assertCostCodeActive((await masterData.getCostCode(tx, costCodeId)).active);
    },

    /** BR-10 */
    async checkVendor(tx: Db, vendorId: string): Promise<void> {
      const party = await masterData.getParty(tx, vendorId);
      assertKnown(party !== undefined, 'vendor_not_found', 'The vendor does not exist');
      assertVendor(party as { roles: string[]; status: string });
    },

    newId,
  };
}
