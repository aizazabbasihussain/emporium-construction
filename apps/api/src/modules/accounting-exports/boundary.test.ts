import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '..');
const root = path.resolve(here, '../../../../..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('test-support.ts')
      ? [full]
      : [];
  });

describe('module boundary (constitution 3)', () => {
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
        if (relative[0] === 'accounting-exports' || relative[0] === '..') continue;
        if (relative.length !== 2 || relative[1] !== 'index.js') {
          offenders.push(`${path.relative(here, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads and writes no table that another module owns', () => {
    const foreign =
      /\b(from|join|into|update)\s+(bil|rcv|pay|pyr|exp|prj|var|sub|cbk|tax|inv|prc|mst|sys|wag|lab|att|val|pft)_\w+/gi;
    const found: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(foreign)) {
        found.push(`${path.relative(here, file)}: ${match[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('owns exactly the four tables of the spec and keeps no balance, journal or statement (AC-3)', () => {
    const migration = readFileSync(
      path.join(root, 'packages/db/migrations/0033_accounting_exports.sql'),
      'utf8',
    )
      .split('\n')
      .filter((text) => !text.trimStart().startsWith('--'))
      .join('\n');
    const tables = [...migration.matchAll(/create table (\w+) \(/g)].map((t) => t[1]);
    expect(tables).toEqual(['acc_accounts', 'acc_mapping_rules', 'acc_tags', 'acc_export_runs']);
    expect(migration).not.toMatch(/journal|trial_balance|balance_sheet|numeric\(18,2\)/i);
  });
});
