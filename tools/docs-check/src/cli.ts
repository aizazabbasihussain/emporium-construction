import { checkDiscovery } from './check.ts';
import { loadDocsInput } from './files.ts';

export interface Output {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** Returns the process exit code: 0 when docs/discovery is valid, 1 otherwise. */
export function main(repoRoot: string, output: Output): number {
  const input = loadDocsInput(repoRoot);
  if (!input) {
    output.error('docs:check: docs/discovery not found');
    return 1;
  }
  const issues = checkDiscovery(input);
  if (issues.length === 0) {
    output.log(`docs:check OK (${Object.keys(input.files).length} files)`);
    return 0;
  }
  for (const issue of issues) {
    output.error(`docs/discovery/${issue.file}:${issue.line}: ${issue.message}`);
  }
  output.error(`docs:check failed with ${issues.length} problem(s)`);
  return 1;
}
