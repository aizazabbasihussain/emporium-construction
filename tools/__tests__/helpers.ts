import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
const scratchRoot = path.join(repoRoot, 'tools/.selftest-tmp');

export interface RunResult {
  status: number | null;
  output: string;
}

/** Run a Node script with the current Node binary (no shell, works on Windows and Linux). */
export function runNode(script: string, args: string[], cwd = repoRoot): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function binOf(pkg: string, bin: string): string {
  return path.join(repoRoot, 'node_modules', pkg, bin);
}

export const vitestBin = () => binOf('vitest', 'vitest.mjs');
export const depcruiseBin = () => binOf('dependency-cruiser', 'bin/dependency-cruiser.mjs');
export const eslintBin = () => binOf('eslint', 'bin/eslint.js');
export const tscBin = () => binOf('typescript', 'bin/tsc');

/** A scratch folder inside the repository so tool resolution (node_modules) keeps working. */
export function makeScratch(): { dir: string; rel: string; cleanup: () => void } {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(path.join(scratchRoot, 'run-'));
  return {
    dir,
    rel: path.relative(repoRoot, dir).split(path.sep).join('/'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
