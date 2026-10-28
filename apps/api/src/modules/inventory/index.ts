// The only public entry point of the inventory module.
import { inventoryNotificationTemplates } from '@emporium/shared';
import { subscribeToEvents } from './service/events.service.js';
import {
  createInventoryService,
  type InventoryDeps,
  type InventoryService,
} from './service/inventory.service.js';

export interface Inventory {
  service: InventoryService;
  /** Module-to-module API (spec P1-12 section 2). */
  getStockOnHand: InventoryService['stock']['getStockOnHand'];
  issueToCostObject: InventoryService['stock']['issue'];
  returnToStore: InventoryService['stock']['returnToStore'];
  receiveClientMaterial: InventoryService['stock']['receiveClientMaterial'];
  hasIssuesFromGrn: InventoryService['stock']['hasIssuesFromGrn'];
}

/**
 * Wires inventory on top of the kernel, valuation, projects, master data, approvals and
 * notifications. Reacts to goods receipts and to the decisions on count adjustments.
 */
export function createInventory(deps: InventoryDeps): Inventory {
  for (const [code, key] of Object.entries(inventoryNotificationTemplates)) {
    deps.notifications.registerTemplate(code, key);
  }
  const service = createInventoryService(deps);
  subscribeToEvents({ platform: deps.platform, stock: service.stock, counts: service.counts });
  return {
    service,
    getStockOnHand: (db, storeId, itemId, ownership, ownerPartyId) =>
      service.stock.getStockOnHand(db, storeId, itemId, ownership, ownerPartyId),
    issueToCostObject: (cmd, actor, tx) => service.stock.issue(cmd, actor, tx),
    returnToStore: (cmd, actor, tx) => service.stock.returnToStore(cmd, actor, tx),
    receiveClientMaterial: (cmd, actor, tx) => service.stock.receiveClientMaterial(cmd, actor, tx),
    hasIssuesFromGrn: (db, grnId) => service.stock.hasIssuesFromGrn(db, grnId),
  };
}

export { registerInventoryRoutes, type InventoryRouteDeps } from './routes/inventory.routes.js';
export type {
  ClientMaterialDto,
  CountDto,
  IntegrityReport,
  LedgerDto,
  MovementDto,
  StockDto,
  StockEventPayload,
  StoreDto,
  TransferDto,
} from './types.js';
