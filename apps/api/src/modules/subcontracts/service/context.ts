import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../../approvals/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Payables } from '../../payables/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import { createRecorder } from './support.js';

export interface SubcontractsDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'transitionCost' | 'reverseCost'>;
  masterData: Pick<MasterData, 'getParty' | 'getCostCode'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  payables: Pick<Payables, 'registerBillSource' | 'getPaidAmount'> & {
    bills: Pick<Payables['bills'], 'createFromSource' | 'get'>;
  };
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder and today's business date. */
export function createContext(deps: SubcontractsDeps) {
  return {
    ...deps,
    record: createRecorder(deps.platform),
    today: (): string => BusinessDate.today(deps.clock).toString(),
  };
}
