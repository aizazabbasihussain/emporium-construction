import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eslintBin, repoRoot, runNode, tscBin, vitestBin } from './helpers';

const name = 'selftestmod';
const moduleDir = path.join(repoRoot, 'apps/api/src/modules', name);
const domainDir = path.join(repoRoot, 'packages/domain/src', name);
const generator = path.join(repoRoot, 'tools/module-new.mjs');

const remove = () => {
  rmSync(moduleDir, { recursive: true, force: true });
  rmSync(domainDir, { recursive: true, force: true });
};

afterAll(remove);

describe('module generator (T-6, AC-4)', () => {
  it('rejects invalid names and prefixes', () => {
    expect(runNode(generator, []).status).toBe(1);
    expect(runNode(generator, ['Bad_Name']).status).toBe(1);
    expect(runNode(generator, ['okname', '--prefix=X1']).status).toBe(1);
    expect(existsSync(path.join(repoRoot, 'apps/api/src/modules/okname'))).toBe(false);
  });

  it('creates a module that compiles, lints and passes its own tests, then refuses to overwrite', () => {
    remove();
    const created = runNode(generator, [name]);
    expect(created.status, created.output).toBe(0);

    for (const file of [
      'apps/api/src/modules/selftestmod/module.json',
      'apps/api/src/modules/selftestmod/index.ts',
      'apps/api/src/modules/selftestmod/routes/selftestmod.routes.ts',
      'apps/api/src/modules/selftestmod/service/selftestmod.service.ts',
      'apps/api/src/modules/selftestmod/policy/selftestmod.policy.ts',
      'apps/api/src/modules/selftestmod/repo/.gitkeep',
      'packages/domain/src/selftestmod/index.ts',
    ]) {
      expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
    }

    const api = runNode(tscBin(), ['--noEmit', '-p', 'apps/api']);
    expect(api.status, api.output).toBe(0);
    const domain = runNode(tscBin(), ['--noEmit', '-p', 'packages/domain']);
    expect(domain.status, domain.output).toBe(0);

    const lint = runNode(eslintBin(), [
      'apps/api/src/modules/selftestmod',
      'packages/domain/src/selftestmod',
    ]);
    expect(lint.status, lint.output).toBe(0);

    const tests = runNode(vitestBin(), [
      'run',
      '--coverage',
      '--coverage.include=apps/api/src/modules/selftestmod/{service,policy}/**/*.ts',
      '--coverage.include=packages/domain/src/selftestmod/**/*.ts',
      '--coverage.reporter=text-summary',
      'selftestmod',
    ]);
    expect(tests.status, tests.output).toBe(0);

    const again = runNode(generator, [name]);
    expect(again.status).toBe(1);
    expect(again.output).toContain('already exists');
  });
});
