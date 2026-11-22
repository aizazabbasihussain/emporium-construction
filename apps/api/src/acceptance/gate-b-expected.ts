import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorksheet } from './expected.js';

const WORKSHEET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/cutover/gate-b-expected.md',
);

let cache: Map<string, string> | undefined;

const rows = (): Map<string, string> => {
  cache ??= parseWorksheet(readFileSync(WORKSHEET, 'utf8'));
  return cache;
};

/** The hand-calculated value for a step of the Gate B scenario (P2-10 BR-3 of the worksheet); an unknown id is an error. */
export function expectedB(id: string): string {
  const value = rows().get(id);
  if (value === undefined)
    throw new Error(`No expected figure "${id}" in docs/cutover/gate-b-expected.md`);
  return value;
}

export function worksheetBIds(): string[] {
  return [...rows().keys()];
}
