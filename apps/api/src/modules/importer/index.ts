// The only public entry point of the importer module.
import type { Platform } from '../platform/index.js';
import { createImportService, type ImportService } from './service/import.service.js';
import { createImporterRegistry, type ImporterRegistry } from './service/registry.service.js';
import { createStagingStore, type StagingStore } from './service/staging.service.js';
import type { Clock } from '@emporium/domain/kernel';
import type { ImporterDefinition } from './types.js';

export interface Importer {
  service: ImportService;
  registry: ImporterRegistry;
  staging: StagingStore;
  /** Modules register their importer at startup (spec P0-04 section 2). */
  registerImporter<T>(definition: ImporterDefinition<T>): void;
}

/** Wires the importer on top of the kernel. Other modules receive the returned object. */
export function createImporter(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  staging?: StagingStore;
}): Importer {
  const registry = createImporterRegistry();
  const staging = deps.staging ?? createStagingStore();
  return {
    service: createImportService({
      registry,
      staging,
      platform: deps.platform,
      clock: deps.clock,
      newId: deps.newId,
    }),
    registry,
    staging,
    registerImporter: (definition) => registry.register(definition),
  };
}

export { registerImporterRoutes, type ImporterRouteDeps } from './routes/importer.routes.js';
export type {
  ApplyContext,
  BatchDto,
  DryRunResult,
  ImporterDefinition,
  ImporterSummary,
} from './types.js';
