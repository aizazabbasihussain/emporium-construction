// Entry point for `pnpm docs:check`. Kept free of logic; see src/cli.ts.
import { main } from './src/cli.ts';

process.exitCode = main(process.cwd(), { log: console.log, error: console.error });
