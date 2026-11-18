import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC-2: no tax rate appears anywhere in source code or default seeds (repository scan).

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');

function filesUnder(directory: string, accept: (file: string) => boolean): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? filesUnder(full, accept) : accept(full) ? [full] : [];
  });
}

const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file);
const isTestSupport = (file: string) => file.endsWith('test-support.ts');

const taxSources = [
  ...filesUnder(path.join(root, 'apps/api/src/modules/tax'), isSource),
  ...filesUnder(path.join(root, 'packages/domain/src/tax'), isSource),
  ...filesUnder(path.join(root, 'apps/web/src/tax'), isSource),
  path.join(root, 'packages/shared/src/tax.ts'),
].filter((file) => !isTestSupport(file));

const rel = (file: string) => path.relative(root, file).replaceAll('\\', '/');

describe('no rate in code or seeds (AC-2)', () => {
  it('finds the tax sources it is meant to scan', () => {
    expect(taxSources.map(rel)).toEqual(
      expect.arrayContaining([
        'apps/api/src/modules/tax/service/engine.service.ts',
        'packages/domain/src/tax/calculate.ts',
        'packages/shared/src/tax.ts',
      ]),
    );
  });

  it('has no percentage literal and no numeric rate assignment in tax source code', () => {
    const offences: string[] = [];
    for (const file of taxSources) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const percent = /\d\s*%/.test(line);
          const rate = /\b\w*[Rr]ate\w*['"]?\s*[:=]\s*['"]?\d*[1-9]/.test(line);
          if (percent || rate) offences.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offences).toEqual([]);
  });

  it('inserts no tax rule, region mapping or withholding rule in any migration', () => {
    const migrations = filesUnder(path.join(root, 'packages/db/migrations'), (f) =>
      f.endsWith('.sql'),
    );
    const offences = migrations.filter((file) =>
      /insert\s+into\s+tax_(rules|withholding_rules|region_map)/i.test(readFileSync(file, 'utf8')),
    );
    expect(offences.map(rel)).toEqual([]);
  });

  it('keeps the seed files for rules header-only', () => {
    for (const name of ['tax_rules.csv', 'withholding_rules.csv']) {
      const lines = readFileSync(path.join(root, 'packages/db/seeds', name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '');
      expect(lines, name).toHaveLength(1);
    }
  });
});
