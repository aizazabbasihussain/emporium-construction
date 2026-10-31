// The only public entry point of the workerportal module.
import {
  createAccountsService,
  type AccountsDeps,
  type AccountsService,
} from './service/accounts.service.js';
import { createSelfService, type SelfDeps, type SelfService } from './service/self.service.js';

export type WorkerPortalDeps = AccountsDeps & SelfDeps;

export interface WorkerPortal {
  accounts: AccountsService;
  self: SelfService;
}

/** Wires the worker portal on top of identity, workforce, attendance and wages. */
export function createWorkerPortal(deps: WorkerPortalDeps): WorkerPortal {
  return { accounts: createAccountsService(deps), self: createSelfService(deps) };
}

export { ensureWorkerRole } from './service/worker-role.service.js';
export {
  registerWorkerPortalRoutes,
  type WorkerPortalRouteDeps,
} from './routes/workerportal.routes.js';
export type {
  AccountDto,
  OwnAdvancesDto,
  OwnAttendanceDto,
  OwnWageLineDto,
  OwnWagesDto,
} from './types.js';
