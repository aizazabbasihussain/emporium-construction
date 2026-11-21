import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('test-support.ts')
      ? [full]
      : [];
  });

describe('module boundary (T-6)', () => {
  const files = sourceFiles(here);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('imports other modules only through their index.js', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '(\.\.?\/[^']+)'/g)].map(
        (match) => match[1] as string,
      );
      for (const specifier of imports) {
        const target = path.resolve(path.dirname(file), specifier);
        const relative = path.relative(modules, target).split(path.sep);
        if (relative[0] === 'profitability' || relative[0] === '..') continue;
        if (relative.length !== 2 || relative[1] !== 'index.js') {
          offenders.push(`${path.relative(here, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads no table or view that another module owns and keeps no copy of financial data (AC-3)', () => {
    const foreign =
      /\b(from|join|into|update)\s+(bil|rcv|pay|pyr|exp|prj|var|sub|cbk|tax|inv|prc|mst|sys|wag|lab|att)_\w+/gi;
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(foreign)) {
        found.push(`${path.relative(here, file)}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
    // The module's own tables hold settings, forecasts and alert state; no amount of cost or billing.
    const migration = readFileSync(
      path.resolve(here, '../../../../../packages/db/migrations/0032_profitability.sql'),
      'utf8',
    );
    const tables = [...migration.matchAll(/create table (pft_\w+) \(([\s\S]*?)\n\);/g)];
    expect(tables.map((t) => t[1])).toEqual(['pft_thresholds', 'pft_forecasts', 'pft_alert_state']);
    const money = tables.flatMap((t) =>
      [...(t[2] as string).matchAll(/^\s+(\w+) numeric\(18,2\)/gm)].map((m) => `${t[1]}.${m[1]}`),
    );
    expect(money).toEqual(['pft_forecasts.cost_to_complete']);
  });
});
