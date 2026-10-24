import type pg from 'pg';
import type { SqlDb } from './types.js';

const noNesting: SqlDb['transaction'] = () => {
  throw new Error('Nested transactions are not supported');
};

function wrap(client: pg.Pool | pg.PoolClient, transaction: SqlDb['transaction']): SqlDb {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const result = await client.query(sql, [...params]);
      return result.rows as T[];
    },
    transaction,
  };
}

export function fromPool(pool: pg.Pool): SqlDb {
  return wrap(pool, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(wrap(client, noNesting));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });
}
