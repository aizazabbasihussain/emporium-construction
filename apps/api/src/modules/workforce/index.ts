// The only public entry point of the workforce module.
import type { ImporterDefinition } from '../importer/index.js';
import { registerWorkforceImporters } from './service/importers.service.js';
import { createTeamsService, type TeamsService } from './service/teams.service.js';
import {
  createWorkersService,
  type WorkersService,
  type WorkforceDeps,
} from './service/workers.service.js';

export interface Workforce {
  workers: WorkersService;
  teams: TeamsService;
  /** Query interfaces for other modules (spec P1-16 section 2). */
  getWorker: WorkersService['get'];
  getWorkerRate: WorkersService['getWorkerRate'];
  getTeamMembers: TeamsService['getTeamMembers'];
  listTeamsForSupervisor: TeamsService['listTeamsForSupervisor'];
  /** Query interfaces for attendance (spec P1-17 section 2): a team, and the teams a caller reaches. */
  getTeam: TeamsService['get'];
  listTeams: TeamsService['list'];
}

/**
 * Wires workers, pay rates and teams on top of the kernel, identity and master data. Registers
 * the four importers (BR-9).
 */
export function createWorkforce(
  deps: WorkforceDeps & {
    /** The importer's `registerImporter`, injected so this module does not call importer internals. */
    registerImporter: <T>(definition: ImporterDefinition<T>) => void;
  },
): Workforce {
  const workers = createWorkersService(deps);
  const teams = createTeamsService(deps);
  registerWorkforceImporters(deps.registerImporter, { workers, teams, identity: deps.identity });
  return {
    workers,
    teams,
    getWorker: (db, id, actor) => workers.get(db, id, actor),
    getWorkerRate: (db, workerId, date) => workers.getWorkerRate(db, workerId, date),
    getTeamMembers: (db, teamId, date) => teams.getTeamMembers(db, teamId, date),
    listTeamsForSupervisor: (db, userId) => teams.listTeamsForSupervisor(db, userId),
    getTeam: (db, id, actor) => teams.get(db, id, actor),
    listTeams: (db, actor) => teams.list(db, actor),
  };
}

export { registerWorkforceRoutes, type WorkforceRouteDeps } from './routes/workforce.routes.js';
export type { AttendanceQuery } from './service/workers.service.js';
export type {
  RateDto,
  TeamDetailDto,
  TeamDto,
  TeamMemberDto,
  TradeDto,
  WorkerDto,
  WorkerRateDto,
} from './types.js';
