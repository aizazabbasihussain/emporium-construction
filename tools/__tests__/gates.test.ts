import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { depcruiseBin, makeScratch, repoRoot, runNode, vitestBin, writeFiles } from './helpers';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('coverage gate (T-5, AC-2)', () => {
  const sources = {
    'src/pick.ts': `export function pick(flag: boolean): string {
  if (flag) return 'yes';
  return 'no';
}
`,
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';
import { coverageOptions } from '../../../vitest.coverage.ts';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], coverage: coverageOptions(['src/**/*.ts']) },
});
`,
  };
  const oneBranch = `import { expect, it } from 'vitest';
import { pick } from './pick.ts';
it('yes', () => expect(pick(true)).toBe('yes'));
`;
  const bothBranches = `${oneBranch}it('no', () => expect(pick(false)).toBe('no'));
`;

  it('fails when a branch is uncovered and passes once it is covered', () => {
    const scratch = makeScratch();
    cleanup = scratch.cleanup;
    writeFiles(scratch.dir, { ...sources, 'src/pick.test.ts': oneBranch });
    const args = ['run', '--coverage', '--root', scratch.dir];

    const failing = runNode(vitestBin(), args);
    expect(failing.status).not.toBe(0);
    expect(failing.output).toMatch(/threshold/i);

    writeFileSync(path.join(scratch.dir, 'src/pick.test.ts'), bothBranches);
    const passing = runNode(vitestBin(), args);
    expect(passing.output).not.toMatch(/threshold.*not met/i);
    expect(passing.status).toBe(0);
  });
});

describe('module boundary gate (T-5, AC-2)', () => {
  function cruise(rel: string): { status: number | null; output: string } {
    const configFile = path.join(repoRoot, rel, 'depcruise.config.cjs');
    writeFileSync(
      configFile,
      `const { buildRules } = require(${JSON.stringify(path.join(repoRoot, 'tools/depcruise-rules.cjs'))});
module.exports = { forbidden: buildRules(${JSON.stringify(rel)}), options: { tsPreCompilationDeps: true } };
`,
    );
    return runNode(depcruiseBin(), [rel, '--config', configFile]);
  }

  const modules = (importPath: string) => ({
    'apps/api/src/modules/alpha/service/use.ts': `import { secret } from '${importPath}';\nexport const used = secret;\n`,
    'apps/api/src/modules/beta/index.ts': `export { secret } from './service/internal';\n`,
    'apps/api/src/modules/beta/service/internal.ts': `export const secret = 1;\n`,
  });

  it('fails on an import of another module internals and passes via index.ts', () => {
    const scratch = makeScratch();
    cleanup = scratch.cleanup;

    writeFiles(scratch.dir, modules('../../beta/service/internal'));
    const failing = cruise(scratch.rel);
    expect(failing.status).not.toBe(0);
    expect(failing.output).toContain('no-other-module-internals');

    writeFiles(scratch.dir, modules('../../beta'));
    expect(cruise(scratch.rel).status).toBe(0);
  });

  it('fails when the domain imports an I/O package and passes when it is pure', () => {
    const scratch = makeScratch();
    cleanup = scratch.cleanup;

    writeFiles(scratch.dir, {
      'packages/domain/src/io.ts': `import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n`,
    });
    const failing = cruise(scratch.rel);
    expect(failing.status).not.toBe(0);
    expect(failing.output).toContain('domain-stays-pure');

    writeFiles(scratch.dir, { 'packages/domain/src/io.ts': `export const read = 1;\n` });
    expect(cruise(scratch.rel).status).toBe(0);
  });

  it('fails when the web app imports the api', () => {
    const scratch = makeScratch();
    cleanup = scratch.cleanup;

    writeFiles(scratch.dir, {
      'apps/api/src/server.ts': `export const server = 1;\n`,
      'apps/web/src/page.ts': `import { server } from '../../api/src/server';\nexport const page = server;\n`,
    });
    const failing = cruise(scratch.rel);
    expect(failing.status).not.toBe(0);
    expect(failing.output).toContain('web-never-imports-api');

    writeFiles(scratch.dir, { 'apps/web/src/page.ts': `export const page = 1;\n` });
    expect(cruise(scratch.rel).status).toBe(0);
  });
});
