// `pnpm gate:b`: runs every Gate B check and writes docs/cutover/gate-b-report.md (spec P2-10).
// The exit code says whether the automated checks passed; the verdict of the gate, which also needs
// the tax sign-off, the independent review, the approved cutover plan and the parallel run, is in the report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { coverageRows, testCounts, type Check } from '../gate-a/report.ts';
import {
  parseFindings,
  parseFinanceStatus,
  renderReport,
  reviewerNamed,
  signedBy,
  verdict,
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
const vitestReport = '.agent-logs/gate-b-vitest.json';

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
  'Tests and 100% business-logic coverage gate, including the finance scenario, the reconciliations with their fault injections, the tax pack, the security sweep, the opening verification and the restore rehearsal',
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

const specs = parseFinanceStatus(read('specs/STATUS.md'));
const review = read('docs/cutover/review-gate-b.md');
const findings = parseFindings(review);
const reviewer = reviewerNamed(review);
const taxSigned = signedBy(read('docs/cutover/tax-signoff.md'));
const cutover = read('docs/cutover/plan.md');
const cutoverApproved =
  signedBy(cutover, 'Approved by (owner)') && signedBy(cutover, 'Approved by (accountant)');
// The parallel run log is checked by its own test; here it counts only as a recorded human result.
const parallelClean = exists('docs/cutover/parallel-run-log.md')
  ? /Paper may stop: yes/i.test(read('docs/cutover/parallel-run-log.md'))
  : false;

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
  taxSignedOff: taxSigned,
  cutoverApproved,
  parallelRunClean: parallelClean,
  verdict: verdict({
    // P2-10 is the last Phase 2 spec to close, so it may still read in-progress while this runs.
    specsDone: specs.filter((row) => row.id !== 'P2-10').every((row) => row.status === 'done'),
    checksPassed: checks.every((check) => check.ok),
    taxSignedOff: taxSigned,
    reviewerNamed: reviewer,
    criticalOpen: findings.filter((f) => f.severity === 'critical' && f.status === 'open').length,
    cutoverApproved,
    parallelRunClean: parallelClean,
  }),
};

fs.writeFileSync(path.join(root, 'docs/cutover/gate-b-report.md'), renderReport(data));
console.log(
  `\nAutomated checks: ${checks.every((check) => check.ok) ? 'passed' : 'FAILED'}. ` +
    `Gate B: ${data.verdict.passed ? 'PASSED' : 'NOT PASSED'} (docs/cutover/gate-b-report.md)`,
);
for (const reason of data.verdict.reasons) console.log(` - ${reason}`);
process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
