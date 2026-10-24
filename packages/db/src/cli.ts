import pg from 'pg';
import { runMigrations } from './migrations.js';
import { fromPool } from './node-postgres.js';
import { MIGRATIONS_DIR } from './test-db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  const result = await runMigrations(fromPool(pool), MIGRATIONS_DIR);
  console.log(`Applied: ${result.applied.length}, already applied: ${result.skipped.length}`);
} finally {
  await pool.end();
}
