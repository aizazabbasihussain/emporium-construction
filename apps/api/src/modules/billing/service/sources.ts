import type { InvoiceSourceType, SupplyKind } from '@emporium/shared';
import { assertSourceFree, assertSourceKnown } from '../policy/billing.policy.js';
import type { Db } from '../types.js';

/** What the caller asks a source provider for (BR-12). */
export interface InvoiceSourceRequest {
  projectId: string;
  /** The stages of the schedule, for the `project_stage` provider. */
  scheduleIds: string[];
  /** The draft being edited: its own stages are free to be chosen again. */
  exceptInvoiceId: string | null;
  supplyKind: SupplyKind;
  nature: string | null;
}

export interface SourceLine {
  scheduleId: string | null;
  description: string;
  amount: string;
  supplyKind: SupplyKind;
  nature: string | null;
}

export interface InvoiceSourceResult {
  /** The stored `source_type` of the invoice. */
  sourceType: InvoiceSourceType;
  lines: SourceLine[];
}

/**
 * BR-12: a provider supplies the lines, the supply kind and the project reference of an invoice.
 * Later specs (work-order and service invoices, P3-04) register their own through the module.
 */
export interface InvoiceSourceProvider {
  buildLines(db: Db, request: InvoiceSourceRequest): Promise<InvoiceSourceResult>;
}

export interface SourceRegistry {
  register(type: string, provider: InvoiceSourceProvider): void;
  resolve(type: string): InvoiceSourceProvider;
}

export function createSourceRegistry(): SourceRegistry {
  const providers = new Map<string, InvoiceSourceProvider>();
  return {
    register(type, provider) {
      assertSourceFree(providers.has(type), type);
      providers.set(type, provider);
    },
    resolve: (type) => assertSourceKnown(providers.get(type), type),
  };
}
