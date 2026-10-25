import { estimationPermissionGrants, estimationPermissions } from '@emporium/shared';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEstimationKit, type EstimationKit } from './test-support.js';

let kit: EstimationKit;
beforeAll(async () => {
  kit = await createEstimationKit();
}, 60_000);
afterAll(() => kit.close());

describe('estimation permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(estimationPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...estimationPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: management and project managers act, the accountant reads', () => {
    for (const permission of Object.values(estimationPermissions)) {
      expect(estimationPermissionGrants[permission], permission).toContain('management');
      expect(estimationPermissionGrants[permission], permission).toContain('project_manager');
      expect(estimationPermissionGrants[permission], permission).not.toContain('supervisor');
    }
    expect(estimationPermissionGrants['estimation.estimate.read']).toContain('accountant');
    for (const permission of Object.values(estimationPermissions)) {
      if (permission !== 'estimation.estimate.read') {
        expect(estimationPermissionGrants[permission], permission).not.toContain('accountant');
      }
    }
  });

  it('every estimation table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'est\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'est_estimate_lines',
      'est_estimates',
      'est_template_lines',
      'est_templates',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});

/** AC-4: no use of eval or dynamic code execution anywhere in the source. */
describe('no dynamic code execution (AC-4)', () => {
  const roots = ['../../../../../packages', '../../../../../apps'].map((p) =>
    join(import.meta.dirname, p),
  );
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(path);
    }
  };
  for (const root of roots) walk(root);

  it('finds no eval(), new Function(), Function() or string timers', () => {
    expect(sources.length).toBeGreaterThan(50);
    const banned = [
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /(^|[^.\w])Function\s*\(/,
      /\bsetTimeout\s*\(\s*['"`]/,
      /\bsetInterval\s*\(\s*['"`]/,
    ];
    const hits: string[] = [];
    for (const file of sources) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      for (const pattern of banned) if (pattern.test(code)) hits.push(`${file}: ${pattern}`);
    }
    expect(hits).toEqual([]);
  });

  it('the formula module switches the lint rules on for itself', () => {
    const formula = readFileSync(
      join(import.meta.dirname, '../../../../../packages/domain/src/estimation/formula.ts'),
      'utf8',
    );
    expect(formula).toMatch(
      /eslint no-eval: "error", no-new-func: "error", no-implied-eval: "error"/,
    );
  });
});
