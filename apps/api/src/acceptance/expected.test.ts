import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expected, parseWorksheet, worksheetIds } from './expected.js';

describe('Gate A worksheet (P1-21 BR-3)', () => {
  it('reads the id, value and calculation rows of a markdown table', () => {
    const rows = parseWorksheet(
      ['| Id | Expected |', '| --- | --- |', '| `a.b` | `12.50` | 5 x 2.50 |', 'text'].join('\n'),
    );
    expect([...rows]).toEqual([['a.b', '12.50']]);
  });

  it('refuses an id that is not in the worksheet', () => {
    expect(() => expected('no.such.figure')).toThrow(/No expected figure/);
  });

  it('is used completely by the scenario: no stale row and no unlisted figure', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenario.test.ts'),
      'utf8',
    );
    const used = new Set([...source.matchAll(/expected\('([\w.]+)'\)/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(worksheetIds().sort());
  });
});
