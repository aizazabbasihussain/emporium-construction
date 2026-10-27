import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './cli.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const temp: string[] = [];

afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const capture = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
  };
};

describe('decisions:check', () => {
  it('AC-1 passes on the repository seeds, examples and ADRs', () => {
    const { logs, errors, output } = capture();
    expect(main(repoRoot, output)).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('decisions:check OK');
    expect(logs[0]).toContain('tax_rules.csv');
  });

  it('AC-2 names the file and row of a seeded fault', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
    temp.push(root);
    fs.cpSync(path.join(repoRoot, 'docs', 'decisions'), path.join(root, 'docs', 'decisions'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(repoRoot, 'packages', 'db', 'seeds'),
      path.join(root, 'packages', 'db', 'seeds'),
      { recursive: true },
    );
    fs.appendFileSync(
      path.join(root, 'packages', 'db', 'seeds', 'cost_codes.csv'),
      '100,Again,,material\n',
    );
    fs.rmSync(path.join(root, 'docs', 'decisions', 'ADR-008-salvage-and-price-variance.md'));
    const { errors, output } = capture();
    expect(main(root, output)).toBe(1);
    expect(errors).toContain('packages/db/seeds/cost_codes.csv:8: duplicate code "100"');
    expect(errors).toContain('docs/decisions/ADR-008: decision record is missing');
    expect(errors.at(-1)).toBe('decisions:check failed with 2 problem(s)');
  });

  it('reports every file as missing in an empty repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
    temp.push(root);
    const { errors, output } = capture();
    expect(main(root, output)).toBe(1);
    expect(errors).toContain('packages/db/seeds/roles.csv: file is missing');
  });
});
