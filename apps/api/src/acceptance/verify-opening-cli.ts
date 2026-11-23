// `pnpm cutover:verify-opening`: compares the opening balances loaded in the database named by
// DATABASE_URL with docs/cutover/opening-control-sheet.md (spec P2-10 BR-1). Exit 1 on any difference.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '@emporium/db';
import { verifyOpening } from './opening.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('cutover:verify-opening: set DATABASE_URL to the database to check.');
  process.exit(1);
}
const sheet = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/cutover/opening-control-sheet.md',
);
const { db, close } = connect(databaseUrl);
try {
  const differences = await verifyOpening(db, readFileSync(sheet, 'utf8'));
  if (differences.length === 0) console.log('cutover:verify-opening: every control total matches.');
  else {
    console.error('cutover:verify-opening: differences found');
    for (const d of differences) {
      console.error(
        ` - ${d.key}: control sheet ${d.controlSheet}, loaded ${d.loaded}, difference ${d.difference}`,
      );
    }
    process.exitCode = 1;
  }
} finally {
  await close();
}
