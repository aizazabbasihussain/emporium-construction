// `pnpm seed:synthetic`: loads the deterministic synthetic company (P1-21 BR-1) into the database
// named by DATABASE_URL, through the real API rules. Synthetic data only; never in production.
import { connect, MIGRATIONS_DIR, runMigrations } from '@emporium/db';
import { createHarness } from './harness.js';
import { loadSyntheticCompany, pilotCompany } from './seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('seed:synthetic: set DATABASE_URL to the pilot database (see .env.example).');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('seed:synthetic: refusing to load synthetic data when NODE_ENV is production.');
  process.exit(1);
}
const withGovernment = process.argv.includes('--with-government');
if (withGovernment && process.env.ALLOW_GOVERNMENT_DATA !== 'true') {
  console.error(
    'seed:synthetic: --with-government needs ALLOW_GOVERNMENT_DATA=true, as for any government project.',
  );
  process.exit(1);
}

const { db, close } = connect(databaseUrl);
try {
  await runMigrations(db, MIGRATIONS_DIR);
  const [existing] = await db.query<{ n: string }>('select count(*)::text as n from mst_parties');
  if (Number(existing?.n) > 0) {
    console.error('seed:synthetic: the database already holds parties; use an empty database.');
    process.exit(1);
  }
  // Only the three identities that load the data are created here; the 12 users of the company are
  // part of the data set itself.
  const harness = await createHarness({
    db,
    users: ['admin', 'owner', 'pm'],
    config: { allowGovernmentData: withGovernment, databaseUrl },
  });
  const summary = await loadSyntheticCompany(harness, pilotCompany(withGovernment));
  console.log('seed:synthetic: loaded', JSON.stringify(summary));
  await harness.close();
} finally {
  await close();
}
