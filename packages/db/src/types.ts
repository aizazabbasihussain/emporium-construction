/** Minimal SQL executor shared by the PGlite (tests) and node-postgres (runtime) adapters. */
export interface SqlDb {
  /** Run one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Run a single parameterised statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run `fn` in a transaction; commits on success, rolls back if `fn` throws. */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
}
