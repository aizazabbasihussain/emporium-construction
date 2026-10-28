import { createContext, type InventoryDeps } from './context.js';
import { createCountsService, type CountsService } from './counts.service.js';
import { createStockService, type StockService } from './stock.service.js';
import { createStoresService, type StoresService } from './stores.service.js';
import { createTransfersService, type TransfersService } from './transfers.service.js';

export interface InventoryService {
  stock: StockService;
  transfers: TransfersService;
  counts: CountsService;
  stores: StoresService;
}

export type { InventoryDeps };

export function createInventoryService(deps: InventoryDeps): InventoryService {
  const ctx = createContext(deps);
  return {
    stock: createStockService(ctx),
    transfers: createTransfersService(ctx),
    counts: createCountsService(ctx),
    stores: createStoresService(ctx),
  };
}
