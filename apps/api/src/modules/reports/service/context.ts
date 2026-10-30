import type { Clock } from '@emporium/domain/kernel';
import type { Attendance } from '../../attendance/index.js';
import type { Crm } from '../../crm/index.js';
import type { Dpr } from '../../dpr/index.js';
import type { Inventory } from '../../inventory/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Procurement } from '../../procurement/index.js';
import type { Projects } from '../../projects/index.js';
import type { Db } from '../types.js';

export interface ReportsDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'listProjectsForUser' | 'getCostSummary'>;
  procurement: Pick<Procurement, 'listOpenPoLines' | 'listOpenRequisitions'>;
  inventory: Pick<Inventory, 'listStockWithValue' | 'listBelowReorder'>;
  attendance: Pick<Attendance, 'getLabourSummary' | 'getHeadcountSeries'>;
  crm: Pick<Crm, 'pipeline' | 'getConversion' | 'listOverdueFollowUps'>;
  dpr: Pick<Dpr, 'listDprs'>;
  masterData: Pick<MasterData, 'getCostCode' | 'getItem' | 'getParty'>;
}

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
  status: string;
  startDate: string | null;
}

/** Names that rows show instead of ids, looked up once per request. */
export interface Lookups {
  project(id: string | null): string;
  projectName(id: string | null): string;
  item(id: string): Promise<{ code: string; name: string }>;
  party(id: string | null): Promise<string | null>;
  costCode(id: string): Promise<{ code: string; name: string }>;
}

export function createLookups(
  deps: Pick<ReportsDeps, 'masterData'>,
  db: Db,
  projects: readonly ProjectRef[],
): Lookups {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const items = new Map<string, { code: string; name: string }>();
  const parties = new Map<string, string | null>();
  const codes = new Map<string, { code: string; name: string }>();
  return {
    project: (id) => (id === null ? '' : (byId.get(id)?.code ?? '')),
    projectName: (id) => (id === null ? '' : (byId.get(id)?.name ?? '')),
    async item(id) {
      const cached = items.get(id);
      if (cached !== undefined) return cached;
      const found = await deps.masterData.getItem(db, id);
      const value = { code: found?.code ?? '', name: found?.name ?? '' };
      items.set(id, value);
      return value;
    },
    async party(id) {
      if (id === null) return null;
      if (!parties.has(id)) parties.set(id, (await deps.masterData.getParty(db, id))?.name ?? null);
      return parties.get(id) ?? null;
    },
    async costCode(id) {
      const cached = codes.get(id);
      if (cached !== undefined) return cached;
      const found = await deps.masterData.getCostCode(db, id);
      const value = { code: found.code, name: found.name };
      codes.set(id, value);
      return value;
    },
  };
}
