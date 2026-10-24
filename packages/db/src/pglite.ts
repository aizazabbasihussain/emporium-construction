import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { SqlDb } from './types.js';

type Queryable = Pick<PGlite | Transaction, 'exec' | 'query'>;

const noNesting: SqlDb['transaction'] = () => {
  throw new Error('Nested transactions are not supported');
};

function wrap(q: Queryable, transaction: SqlDb['transaction']): SqlDb {
  return {
    async exec(sql) {
      await q.exec(sql);
    },
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const result = await q.query<T>(sql, [...params]);
      return result.rows;
    },
    transaction,
  };
}

export function fromPglite(pg: PGlite): SqlDb {
  return wrap(pg, (fn) => pg.transaction((tx) => fn(wrap(tx, noNesting))));
}
