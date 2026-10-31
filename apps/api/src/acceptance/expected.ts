import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSHEET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/pilot/gate-a-expected.md',
);

/** Reads the `| \`id\` | \`value\` | calculation |` rows of the Gate A worksheet (P1-21 BR-3). */
export function parseWorksheet(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*`([A-Za-z0-9.]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) rows.set(match[1] as string, match[2] as string);
  }
  return rows;
}

let cache: Map<string, string> | undefined;

/** The hand-calculated value for a step of the scenario; an unknown id is an error. */
export function expected(id: string): string {
  cache ??= parseWorksheet(readFileSync(WORKSHEET, 'utf8'));
  const value = cache.get(id);
  if (value === undefined)
    throw new Error(`No expected figure "${id}" in docs/pilot/gate-a-expected.md`);
  return value;
}

export function worksheetIds(): string[] {
  expected('estimate.companyCost');
  return [...(cache as Map<string, string>).keys()];
}
