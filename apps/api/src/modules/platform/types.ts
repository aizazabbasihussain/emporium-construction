import type { SqlDb } from '@emporium/db';

/** A database handle: either the pool-backed database or an open transaction. */
export type Db = SqlDb;

/** The authenticated caller. Produced by the auth layer (P1-02); the kernel only needs these fields. */
export interface Principal {
  userId: string;
  permissions: ReadonlySet<string>;
}
