// Pure parts of `pnpm gate:a` (spec P1-21 BR-10): reading the status table, the review log and the
// UAT checklist, deciding the verdict and rendering docs/pilot/gate-a-report.md.

export interface SpecRow {
  id: string;
  title: string;
  status: string;
}

export interface Finding {
  no: string;
  severity: string;
  area: string;
  text: string;
  status: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  files: number;
}

export interface CoverageRow {
  metric: string;
  pct: number;
  covered: number;
  total: number;
}

export interface Check {
  name: string;
  ok: boolean;
}

export interface Verdict {
  passed: boolean;
  reasons: string[];
}

export interface ReportData {
  date: string;
  specs: SpecRow[];
  checks: Check[];
  tests: TestCounts | undefined;
  coverage: CoverageRow[] | undefined;
  findings: Finding[];
  reviewerNamed: boolean;
  uat: { checked: number; open: number };
  verdict: Verdict;
}

/** Phase 1 rows of specs/STATUS.md: `| P1-01 | Title | done | ...`. */
export function parsePhaseOneStatus(statusMarkdown: string): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const line of statusMarkdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length > 4 && /^P1-\d+$/.test(cells[1] ?? '')) {
      rows.push({ id: cells[1] as string, title: cells[2] ?? '', status: cells[3] ?? '' });
    }
  }
  return rows;
}

/** Counts checklist boxes: `- [x]`, `- [ ]` and table cells holding `[x]` or `[ ]`. */
export function countBoxes(markdown: string): { checked: number; open: number } {
  let checked = 0;
  let open = 0;
  for (const line of markdown.split('\n')) {
    if (/^\s*(?:- )?\[x\]/i.test(line) || /\|\s*\[x\]\s*\|?\s*$/i.test(line)) checked += 1;
    else if (/^\s*(?:- )?\[ \]/.test(line) || /\|\s*\[ \]\s*\|?\s*$/.test(line)) open += 1;
  }
  return { checked, open };
}

/** Rows of the findings table of the review log: `| 1 | critical | area | text | open | ... |`. */
export function parseFindings(reviewMarkdown: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of reviewMarkdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (/^\d+$/.test(cells[1] ?? '') && cells.length >= 7) {
      findings.push({
        no: cells[1] as string,
        severity: (cells[2] ?? '').toLowerCase(),
        area: cells[3] ?? '',
        text: cells[4] ?? '',
        status: (cells[5] ?? '').toLowerCase(),
      });
    }
  }
  return findings;
}

/** True when the review log names a reviewer (the placeholder says "Not named yet"). */
export function reviewerNamed(reviewMarkdown: string): boolean {
  const row = reviewMarkdown.split('\n').find((line) => /^\|\s*Reviewer\s*\|/.test(line));
  return row !== undefined && !/not named yet/i.test(row);
}

interface VitestJson {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: unknown[];
}

/** Total test counts from a Vitest JSON report. */
export function testCounts(report: VitestJson): TestCounts {
  return {
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    files: (report.testResults ?? []).length,
  };
}

type Metric = { pct?: number; covered?: number; total?: number };

/** The coverage summary of the business logic (the `total` entry of coverage-summary.json). */
export function coverageRows(summary: { total?: Record<string, Metric> }): CoverageRow[] {
  const total = summary.total ?? {};
  return ['lines', 'branches', 'functions', 'statements'].map((metric) => ({
    metric,
    pct: total[metric]?.pct ?? 0,
    covered: total[metric]?.covered ?? 0,
    total: total[metric]?.total ?? 0,
  }));
}

export interface VerdictInput {
  specsDone: boolean;
  checksPassed: boolean;
  reviewerNamed: boolean;
  criticalOpen: number;
  uatOpen: number;
}

/**
 * The gate passes only when every check is green and the human steps are done. The list of reasons
 * is what the report prints, so a reader sees exactly what is still open.
 */
export function verdict(input: VerdictInput): Verdict {
  const reasons: string[] = [];
  if (!input.specsDone) reasons.push('Not every Phase 1 spec is done.');
  if (!input.checksPassed) reasons.push('An automated check failed.');
  if (!input.reviewerNamed) reasons.push('No independent reviewer is named (input H-19).');
  if (input.criticalOpen > 0) {
    reasons.push(`${input.criticalOpen} critical review finding(s) are open.`);
  }
  if (input.uatOpen > 0) reasons.push(`${input.uatOpen} UAT item(s) or sign-offs are not done.`);
  return { passed: reasons.length === 0, reasons };
}

const cell = (value: string | number) => String(value).replaceAll('|', '/');

/** The Gate A report (BR-10). `data` holds everything `run.ts` collected. */
export function renderReport(data: ReportData): string {
  const lines: string[] = [];
  const push = (...parts: string[]) => lines.push(...parts);
  push('# Gate A report', '');
  push(
    `Generated by \`pnpm gate:a\` on ${data.date}. Do not edit by hand: change the sources (\`specs/STATUS.md\`, \`review-gate-a.md\`, \`uat-checklist.md\`) and run it again.`,
    '',
  );
  push(`## Result: ${data.verdict.passed ? 'PASSED' : 'NOT PASSED'}`, '');
  if (data.verdict.passed) push('Every check is green and the human steps are complete.', '');
  else push(...data.verdict.reasons.map((reason) => `- ${reason}`), '');
  push(
    '**Financial go-live and government data are not yet permitted.** Gate A covers an operational pilot with synthetic or private-client data only. Billing, payments and tax belong to Phase 2 (Gate B) and government data to Gate C.',
    '',
  );
  push('## Phase 1 specs', '', '| ID | Title | Status |', '| --- | --- | --- |');
  for (const row of data.specs) push(`| ${row.id} | ${cell(row.title)} | ${row.status} |`);
  push('');
  push('## Automated checks', '', '| Check | Result |', '| --- | --- |');
  for (const check of data.checks) {
    push(`| ${cell(check.name)} | ${check.ok ? 'passed' : 'FAILED'} |`);
  }
  push('');
  push('## Test counts', '');
  if (data.tests === undefined) push('_Not collected._', '');
  else {
    const t = data.tests;
    push(
      `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped, of ${t.total} tests in ${t.files} files.`,
      '',
    );
  }
  push('## Coverage (business logic)', '');
  if (data.coverage === undefined) push('_Not collected._', '');
  else {
    push('| Metric | Covered | Total | Percent |', '| --- | --- | --- | --- |');
    for (const row of data.coverage) {
      push(`| ${row.metric} | ${row.covered} | ${row.total} | ${row.pct}% |`);
    }
    push('');
  }
  push('## Open defects', '');
  const defects = data.findings.filter((finding) => finding.status === 'open');
  if (defects.length === 0) push('None recorded.', '');
  else {
    push(...defects.map((d) => `- #${d.no} (${d.severity}, ${d.area}): ${d.text}`), '');
  }
  push('## Review findings', '');
  push(
    data.reviewerNamed
      ? `${data.findings.length} finding(s) recorded in \`docs/pilot/review-gate-a.md\`.`
      : 'The independent review has not taken place: the reviewer is not named (H-19). The pilot may run on synthetic data only.',
    '',
  );
  push('## UAT sign-offs', '');
  push(
    `${data.uat.checked} item(s) checked, ${data.uat.open} open, in \`docs/pilot/uat-checklist.md\`.`,
    '',
  );
  return `${lines.join('\n')}\n`;
}
