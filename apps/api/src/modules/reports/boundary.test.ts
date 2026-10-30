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

describe('module boundary (T-7)', () => {
  const files = sourceFiles(here);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(8);
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
        if (relative[0] === 'reports' || relative[0] === '..') continue;
        if (relative.length !== 2 || relative[1] !== 'index.js') {
          offenders.push(`${path.relative(here, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads no table that another module owns, except the published client material view', () => {
    const foreign =
      /\b(from|join|into|update)\s+(inv|prc|att|crm|prj|dpr|mst|sys|wag|lab|exp)_(?!v_)\w+/gi;
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(foreign))
        found.push(`${path.relative(here, file)}: ${match[0]}`);
    }
    expect(found).toEqual([]);
    const views = files
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\b[a-z]{2,3}_v_\w+/g)])
      .map((match) => match[0]);
    expect([...new Set(views)]).toEqual(['inv_v_client_material_balance']);
  });
});
