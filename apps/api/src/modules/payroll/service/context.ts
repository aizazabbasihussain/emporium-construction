import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../../approvals/index.js';
import type { Attendance } from '../../attendance/index.js';
import type { Cashbook } from '../../cashbook/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Wages } from '../../wages/index.js';
import type { Db } from '../types.js';
import { createRecorder } from './support.js';

export interface PayrollDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** The approved wage sheet and its reconciliation; payroll never recalculates wages. */
  wages: Pick<Wages, 'getApprovedWageSheet'> & {
    periods: Pick<Wages['periods'], 'get' | 'reconciliation'>;
  };
  /** Approved attendance tells which projects carried the month's labour. */
  attendance: Pick<Attendance, 'getApprovedAttendance'>;
  projects: Pick<Projects, 'postCost' | 'transitionCost' | 'reverseCost'> & {
    costing: Pick<Projects['costing'], 'listEntries'>;
  };
  cashbook: Pick<Cashbook, 'recordPayment'> & {
    transactions: Pick<Cashbook['transactions'], 'reverse'>;
  };
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
  masterData: Pick<MasterData, 'costing'>;
}

export type Context = ReturnType<typeof createContext>;

/** What every sub-service shares: the dependencies, the recorder and today's business date. */
export function createContext(deps: PayrollDeps) {
  return {
    ...deps,
    record: createRecorder(deps.platform),
    today: (): string => BusinessDate.today(deps.clock).toString(),
    async setting(db: Db, key: string): Promise<unknown> {
      return (await deps.platform.settings.get(db, key)).value;
    },
  };
}
