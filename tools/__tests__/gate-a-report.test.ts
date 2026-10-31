import { describe, expect, it } from 'vitest';
import {
  countBoxes,
  coverageRows,
  parseFindings,
  parsePhaseOneStatus,
  renderReport,
  reviewerNamed,
  testCounts,
  verdict,
  type ReportData,
} from '../gate-a/report.ts';

const base: ReportData = {
  date: '2026-10-30',
  specs: [{ id: 'P1-01', title: 'Platform | kernel', status: 'done' }],
  checks: [{ name: 'Lint', ok: true }],
  tests: { total: 10, passed: 9, failed: 0, skipped: 1, files: 3 },
  coverage: [{ metric: 'lines', pct: 100, covered: 5, total: 5 }],
  findings: [],
  reviewerNamed: false,
  uat: { checked: 2, open: 3 },
  verdict: { passed: false, reasons: ['No independent reviewer is named (input H-19).'] },
};

describe('Gate A report tool (P1-21 BR-10)', () => {
  it('reads the Phase 1 rows of the status table and ignores other rows', () => {
    const rows = parsePhaseOneStatus(
      [
        '| ID | Title | Status |',
        '|---|---|---|',
        '| P0-01 | Bootstrap | done | - |',
        '| P1-01 | Platform kernel | done | P0-01 | no | - |',
        '| P1-21 | Phase 1 acceptance | in-progress | P1-10 | no | H-19 |',
        '| P2-01 | Tax engine | not-started | P1-05 |',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { id: 'P1-01', title: 'Platform kernel', status: 'done' },
      { id: 'P1-21', title: 'Phase 1 acceptance', status: 'in-progress' },
    ]);
  });

  it('counts list and table checkboxes', () => {
    expect(
      countBoxes(
        [
          '- [x] done',
          '- [ ] open',
          '| Owner | Ann | 2026 | [x] |',
          '| Cook | | | [ ] |',
          'text [ ]',
        ].join('\n'),
      ),
    ).toEqual({ checked: 2, open: 2 });
  });

  it('reads findings and tells whether a reviewer is named', () => {
    const log = [
      '| Reviewer | **Not named yet.** |',
      '| No | Severity | Area | Finding | Status | Resolution |',
      '| -- | -- | -- | -- | -- | -- |',
      '| 1 | Critical | RLS | A table lacks RLS | open | |',
      '| 2 | minor | UI | Typo | fixed | done |',
    ].join('\n');
    expect(parseFindings(log)).toEqual([
      { no: '1', severity: 'critical', area: 'RLS', text: 'A table lacks RLS', status: 'open' },
      { no: '2', severity: 'minor', area: 'UI', text: 'Typo', status: 'fixed' },
    ]);
    expect(reviewerNamed(log)).toBe(false);
    expect(reviewerNamed('| Reviewer | A. Khan, independent |')).toBe(true);
    expect(reviewerNamed('no reviewer row')).toBe(false);
  });

  it('summarises Vitest and coverage JSON, tolerating missing fields', () => {
    expect(
      testCounts({
        numTotalTests: 5,
        numPassedTests: 3,
        numFailedTests: 1,
        numPendingTests: 1,
        numTodoTests: 1,
        testResults: [{}, {}],
      }),
    ).toEqual({ total: 5, passed: 3, failed: 1, skipped: 2, files: 2 });
    expect(testCounts({})).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, files: 0 });
    expect(coverageRows({ total: { lines: { pct: 100, covered: 4, total: 4 } } })[0]).toEqual({
      metric: 'lines',
      pct: 100,
      covered: 4,
      total: 4,
    });
    expect(coverageRows({})[1]).toEqual({ metric: 'branches', pct: 0, covered: 0, total: 0 });
  });

  it('passes only when checks, specs, reviewer, findings and UAT are all in order', () => {
    const ok = {
      specsDone: true,
      checksPassed: true,
      reviewerNamed: true,
      criticalOpen: 0,
      uatOpen: 0,
    };
    expect(verdict(ok)).toEqual({ passed: true, reasons: [] });
    const bad = verdict({
      specsDone: false,
      checksPassed: false,
      reviewerNamed: false,
      criticalOpen: 2,
      uatOpen: 4,
    });
    expect(bad.passed).toBe(false);
    expect(bad.reasons).toHaveLength(5);
  });

  it('renders the report with the not-permitted statement, and without data when it is missing', () => {
    const text = renderReport(base);
    expect(text).toContain('## Result: NOT PASSED');
    expect(text).toContain('Financial go-live and government data are not yet permitted');
    expect(text).toContain('| P1-01 | Platform / kernel | done |');
    expect(text).toContain('9 passed, 0 failed, 1 skipped, of 10 tests in 3 files.');
    expect(text).toContain('| lines | 5 | 5 | 100% |');
    expect(text).toContain('reviewer is not named');
    expect(text).toContain('2 item(s) checked, 3 open');
    const bare = renderReport({ ...base, tests: undefined, coverage: undefined });
    expect(bare.match(/_Not collected\._/g)).toHaveLength(2);
  });

  it('lists open defects and a passed verdict', () => {
    const text = renderReport({
      ...base,
      checks: [{ name: 'Tests', ok: false }],
      findings: [{ no: '1', severity: 'major', area: 'Wages', text: 'Rounding', status: 'open' }],
      reviewerNamed: true,
      verdict: { passed: true, reasons: [] },
    });
    expect(text).toContain('## Result: PASSED');
    expect(text).toContain('| Tests | FAILED |');
    expect(text).toContain('- #1 (major, Wages): Rounding');
    expect(text).toContain('1 finding(s) recorded');
  });
});
