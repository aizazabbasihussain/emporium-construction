// The only public entry point of the procurement module.
import { grnEntityType } from '@emporium/shared';
import { canAccessGrnPhoto } from './policy/procurement.policy.js';
import { subscribeToDecisions } from './service/approval-events.service.js';
import { noGuards, type GrnGuards, type ProcurementDeps } from './service/context.js';
import {
  createProcurementService,
  type ProcurementService,
} from './service/procurement.service.js';

export interface Procurement {
  service: ProcurementService;
  /** Query interfaces for other modules (spec P1-11 section 2). */
  getPurchaseOrder: ProcurementService['orders']['get'];
  listOpenPoLines: ProcurementService['orders']['listOpenLines'];
  getGrn: ProcurementService['receipts']['find'];
}

/**
 * Wires procurement on top of the kernel, projects, approvals, master data and files. Reacts to the
 * decisions of the approval engine and registers the access rule for the delivery challan photo.
 */
export function createProcurement(
  deps: Omit<ProcurementDeps, 'guards'> & { guards?: GrnGuards },
): Procurement {
  const service = createProcurementService({ ...deps, guards: deps.guards ?? noGuards });
  subscribeToDecisions({
    platform: deps.platform,
    requisitions: service.requisitions,
    orders: service.orders,
  });
  deps.files.registerFileAccess(
    grnEntityType,
    async ({ actor, entityId, operation, db }) =>
      canAccessGrnPhoto({
        permissions: actor.permissions,
        operation,
        grnExists: await service.receipts.exists(db, entityId),
      }),
    // The challan photo is the proof of what was delivered: its files are kept.
    { retainForever: true },
  );
  return {
    service,
    getPurchaseOrder: (db, id) => service.orders.get(db, id),
    listOpenPoLines: (db, filter) => service.orders.listOpenLines(db, filter),
    getGrn: (db, id) => service.receipts.find(db, id),
  };
}

export {
  registerProcurementRoutes,
  type ProcurementRouteDeps,
} from './routes/procurement.routes.js';
export type { GrnGuards } from './service/context.js';
export type { GoodsReceivedPayload, GrnDto, OpenPoLineDto, PoDto, PrintModelDto } from './types.js';
