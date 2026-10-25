// The only public entry point of the masterdata module.
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../platform/index.js';
import type { ImporterDefinition } from '../importer/index.js';
import { createCatalogService, type CatalogService } from './service/catalog.service.js';
import { createCompanyService, type CompanyService } from './service/company.service.js';
import { createCostingService, type CostingService } from './service/costing.service.js';
import { registerMasterImporters } from './service/importers.service.js';
import { createPartiesService, type PartiesService } from './service/parties.service.js';
import { createReferences, type References } from './service/references.service.js';

export interface MasterData {
  parties: PartiesService;
  catalog: CatalogService;
  costing: CostingService;
  company: CompanyService;
  /** Query interfaces for other modules (spec P1-05 section 2). */
  getParty: PartiesService['find'];
  searchParties: PartiesService['search'];
  getItem: CatalogService['findItem'];
  getItemCategory: CatalogService['getCategory'];
  getUnit: CatalogService['getUnit'];
  convertQuantity: CatalogService['convert'];
  getCostCode: CostingService['getCostCode'];
  getRegistration: CompanyService['getRegistration'];
  listLocations: CompanyService['listLocations'];
  registerReferenceCheck: References['registerReferenceCheck'];
  registerCostCodeUsage: References['registerCostCodeUsage'];
}

/** Wires master data on top of the kernel. Other modules receive the returned object. */
export function createMasterData(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** The importer's `registerImporter`, injected so this module does not call importer internals. */
  registerImporter: <T>(definition: ImporterDefinition<T>) => void;
}): MasterData {
  const { platform, clock, newId } = deps;
  const references = createReferences();
  const parties = createPartiesService({ platform, clock, newId, references });
  const catalog = createCatalogService({ platform, clock, newId, references });
  const costing = createCostingService({ platform, clock, newId, references });
  const company = createCompanyService({ platform, clock, newId });
  registerMasterImporters(deps.registerImporter, { parties, catalog, costing, company });
  return {
    parties,
    catalog,
    costing,
    company,
    getParty: (db, id) => parties.find(db, id),
    searchParties: (db, query) => parties.search(db, query),
    getItem: (db, id) => catalog.findItem(db, id),
    getItemCategory: (db, id) => catalog.getCategory(db, id),
    getUnit: (db, code) => catalog.getUnit(db, code),
    convertQuantity: (db, quantity, from, to) => catalog.convert(db, quantity, from, to),
    getCostCode: (db, id) => costing.getCostCode(db, id),
    getRegistration: (db, authority, options) => company.getRegistration(db, authority, options),
    listLocations: (db, region) => company.listLocations(db, region),
    registerReferenceCheck: (entity, check) => references.registerReferenceCheck(entity, check),
    registerCostCodeUsage: (check) => references.registerCostCodeUsage(check),
  };
}

export { registerMasterDataRoutes, type MasterDataRouteDeps } from './routes/masterdata.routes.js';
export type {
  CategoryDto,
  CompanyDto,
  ConversionDto,
  CostCodeDto,
  ItemDto,
  LocationDto,
  PartyDto,
  RegistrationDto,
  UnitDto,
  VendorPriceDto,
} from './types.js';
