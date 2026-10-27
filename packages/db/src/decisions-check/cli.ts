import fs from 'node:fs';
import path from 'node:path';
import {
  seedFileNames,
  validateAdrs,
  validateSeeds,
  type DecisionIssue,
} from '@emporium/domain/decisions';

export interface Output {
  log: (message: string) => void;
  error: (message: string) => void;
}

const readDir = (dir: string, accept: (name: string) => boolean): Record<string, string> =>
  Object.fromEntries(
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter(accept)
          .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')])
      : [],
  );

/** Returns the process exit code: 0 when seeds, examples and ADRs are valid, 1 otherwise. */
export function main(repoRoot: string, output: Output): number {
  const decisions = path.join(repoRoot, 'docs', 'decisions');
  const targets: [string, Record<string, string>][] = [
    [
      'packages/db/seeds',
      readDir(path.join(repoRoot, 'packages', 'db', 'seeds'), (n) => n.endsWith('.csv')),
    ],
    [
      'docs/decisions/examples',
      readDir(path.join(decisions, 'examples'), (n) => n.endsWith('.csv')),
    ],
  ];
  const problems: string[] = [];
  const show = (dir: string, issue: DecisionIssue) =>
    problems.push(`${dir}/${issue.file}${issue.row > 0 ? `:${issue.row}` : ''}: ${issue.message}`);

  for (const [dir, files] of targets) {
    const report = validateSeeds(files);
    report.issues.forEach((issue) => show(dir, issue));
    if (dir === 'packages/db/seeds') {
      output.log(`pending (header only): ${report.headerOnly.join(', ') || 'none'}`);
    }
  }
  validateAdrs(readDir(decisions, (n) => /^ADR-.*\.md$/.test(n))).forEach((issue) =>
    show('docs/decisions', issue),
  );

  if (problems.length === 0) {
    output.log(`decisions:check OK (${seedFileNames.length} seed files, 8 ADRs)`);
    return 0;
  }
  problems.forEach((problem) => output.error(problem));
  output.error(`decisions:check failed with ${problems.length} problem(s)`);
  return 1;
}
