import type { ExportRow, TaggableLine } from '@emporium/domain/accounting';
import type { Clock } from '@emporium/domain/kernel';
import type { Files } from '../../files/index.js';
import type { Platform } from '../../platform/index.js';
import type { Actor, Db, ExportCode, ExportFilters } from '../types.js';

/** One taggable line with what the untagged queue shows next to it. */
export interface TaggableDoc extends TaggableLine {
  number: string;
  party: string;
  amount: string;
  description: string;
}

/** What an export reads: its rows, and the figures the owning modules report for BR-5. */
export interface Loaded {
  rows: ExportRow[];
  control: Record<string, string>;
}

export interface LoadContext {
  actor: Actor;
  /** H-06: the month the fiscal year starts; used for labels only. */
  fiscalStartMonth: number;
}

/**
 * What the module reads from the owning modules (spec P2-09 section 2). `adapters/sources.ts` builds
 * it from their exported query functions; tests give it scripted data.
 */
export interface ExportSources {
  load(db: Db, code: ExportCode, filters: ExportFilters, ctx: LoadContext): Promise<Loaded>;
  /** The financial document lines of a period that can carry a tag, from every owning module. */
  taggable(db: Db, range: { from?: string; to?: string }, actor: Actor): Promise<TaggableDoc[]>;
}

export interface AccountingDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  sources: ExportSources;
  files: Pick<Files, 'attach' | 'registerFileAccess'>;
}
