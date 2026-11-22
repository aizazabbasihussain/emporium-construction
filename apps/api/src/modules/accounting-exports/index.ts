// The only public entry point of the accounting-exports module.
import type { Clock } from '@emporium/domain/kernel';
import { accountingPermissions } from '@emporium/shared';
import type { Files } from '../files/index.js';
import type { Platform } from '../platform/index.js';
import { createExportSources, type SourceDeps } from './adapters/sources.js';
import {
  createExportsService,
  exportRunEntityType,
  type ExportsService,
} from './service/exports.service.js';
import { createTaggingService, type TaggingService } from './service/tagging.service.js';

export interface Accounting {
  exports: ExportsService;
  tagging: TaggingService;
  /** Module interfaces (spec P2-09 section 2). */
  tagTransaction: TaggingService['tagTransaction'];
  listUntagged: TaggingService['listUntagged'];
  runExport: ExportsService['run'];
}

export interface AccountingDeps extends SourceDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  files: Pick<Files, 'attach' | 'registerFileAccess'>;
}

/**
 * Wires the accountant exports on top of the exported query functions of billing, receivables,
 * payables, subcontracts, payroll, the cash book, valuation, tax, projects and profitability. It
 * creates no journal and changes no source document.
 */
export function createAccounting(deps: AccountingDeps): Accounting {
  const sources = createExportSources(deps);
  const parts = { ...deps, sources };
  const exports = createExportsService(parts);
  const tagging = createTaggingService(parts);
  // The files of a run are stored by the run itself and opened by whoever may read or run exports
  // (BR-8); nobody removes them (they are the record of what was handed to the accountant).
  deps.files.registerFileAccess(
    exportRunEntityType,
    async ({ actor, operation }) => {
      const mayRun = actor.permissions.has(accountingPermissions.exportRun);
      if (operation === 'upload') return mayRun;
      return (
        operation === 'read' && (mayRun || actor.permissions.has(accountingPermissions.exportRead))
      );
    },
    { retainForever: true },
  );
  return {
    exports,
    tagging,
    tagTransaction: (target, accountCode, actor, tx) =>
      tagging.tagTransaction(target, accountCode, actor, tx),
    listUntagged: (db, query, actor) => tagging.listUntagged(db, query, actor),
    runExport: (code, filters, actor, tx) => exports.run(code, filters, actor, tx),
  };
}

export { registerAccountingRoutes, type AccountingRouteDeps } from './routes/accounting.routes.js';
export type {
  AccountDto,
  BackfillPlanDto,
  ExportInfoDto,
  RuleDto,
  RunDto,
  RunResultDto,
  TagDto,
  UntaggedDto,
  UntaggedPageDto,
} from './types.js';
