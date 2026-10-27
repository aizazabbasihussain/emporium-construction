// Entry point for `pnpm decisions:check`. Kept free of logic; see cli.ts.
import { main } from './cli.js';

process.exitCode = main(process.cwd(), { log: console.log, error: console.error });
