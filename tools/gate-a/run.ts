// `pnpm gate:a`: runs every Gate A check and writes docs/pilot/gate-a-report.md (spec P1-21).
// The exit code says whether the automated checks passed; the verdict of the gate, which also needs
// the independent review and the UAT sign-offs, is in the report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  countBoxes,
  coverageRows,
  parseFindings,
  parsePhaseOneStatus,
  renderReport,
  reviewerNamed,
  testCounts,
  verdict,
  type Check,
  type ReportData,
} from './report.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = (file: string): never => JSON.parse(read(file)) as never;
const exists = (file: string) => fs.existsSync(path.join(root, file));

const windows = process.platform === 'win32';
const run = (args: string[]) =>
  spawnSync(windows ? 'pnpm.cmd' : 'pnpm', args, { cwd: root, stdio: 'inherit', shell: windows })
    .status === 0;

fs.mkdirSync(path.join(root, '.agent-logs'), { recursive: true });
const vitestReport = '.agent-logs/gate-a-vitest.json';

const checks: Check[] = [];
const step = (name: string, args: string[]) => {
  console.log(`\n=== ${name}`);
  checks.push({ name, ok: run(args) });
};

step('Spec index', ['spec:check']);
step('Lint', ['lint']);
step('Typecheck', ['typecheck']);
step('Module boundaries', ['boundaries']);
step(
  'Tests, 100% business-logic coverage gate, Gate A scenario, security, integrity, performance and restore checks',
  [
    'exec',
    'vitest',
    'run',
    '--coverage',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${vitestReport}`,
  ],
);
step('Browser smoke tests for each role', [
  '--filter',
  '@emporium/web',
  'e2e',
  'e2e/gate-a.spec.ts',
]);

const specs = parsePhaseOneStatus(read('specs/STATUS.md'));
const review = exists('docs/pilot/review-gate-a.md') ? read('docs/pilot/review-gate-a.md') : '';
const uat = exists('docs/pilot/uat-checklist.md')
  ? countBoxes(read('docs/pilot/uat-checklist.md'))
  : { checked: 0, open: 1 };
const findings = parseFindings(review);
const reviewer = reviewerNamed(review);

const data: ReportData = {
  date: new Date().toISOString().slice(0, 10),
  specs,
  checks,
  tests: exists(vitestReport) ? testCounts(readJson(vitestReport)) : undefined,
  coverage: exists('coverage/coverage-summary.json')
    ? coverageRows(readJson('coverage/coverage-summary.json'))
    : undefined,
  findings,
  reviewerNamed: reviewer,
  uat,
  verdict: verdict({
    // P1-21 is the last Phase 1 spec to close, so it may still read in-progress while this runs.
    specsDone: specs.filter((row) => row.id !== 'P1-21').every((row) => row.status === 'done'),
    checksPassed: checks.every((check) => check.ok),
    reviewerNamed: reviewer,
    criticalOpen: findings.filter((f) => f.severity === 'critical' && f.status === 'open').length,
    uatOpen: uat.open,
  }),
};

fs.writeFileSync(path.join(root, 'docs/pilot/gate-a-report.md'), renderReport(data));
console.log(
  `\nAutomated checks: ${checks.every((check) => check.ok) ? 'passed' : 'FAILED'}. ` +
    `Gate A: ${data.verdict.passed ? 'PASSED' : 'NOT PASSED'} (docs/pilot/gate-a-report.md)`,
);
for (const reason of data.verdict.reasons) console.log(` - ${reason}`);
process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
