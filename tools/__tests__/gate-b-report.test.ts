import { describe, expect, it } from 'vitest';
import {
  parseFinanceStatus,
  renderReport,
  signedBy,
  verdict,
  type ReportData,
} from '../gate-b/report.ts';

const green = {
  specsDone: true,
  checksPassed: true,
  taxSignedOff: true,
  reviewerNamed: true,
  criticalOpen: 0,
  cutoverApproved: true,
  parallelRunClean: true,
};

describe('Gate B report tool (P2-10 BR-10)', () => {
  it('reads Phase 1 and Phase 2 rows of the status table only', () => {
    const rows = parseFinanceStatus(
      [
        '| P0-01 | Bootstrap | done | - |',
        '| P1-01 | Platform kernel | done | P0-01 | no | - |',
        '| P2-10 | Gate B | in-progress | P2-08 | no | H-19 |',
        '| P3-01 | Maintenance | not-started | P2-10 |',
      ].join('\n'),
    );
    expect(rows.map((row) => row.id)).toEqual(['P1-01', 'P2-10']);
  });

  it('reads a sign-off row and treats the placeholder as unsigned', () => {
    expect(signedBy('| Signed by | A. Accountant |')).toBe(true);
    expect(signedBy('| Signed by | **Not signed yet.** |')).toBe(false);
    expect(signedBy('| Approved by (owner) | **Not approved yet.** |', 'Approved by (owner)')).toBe(
      false,
    );
    expect(signedBy('nothing')).toBe(false);
  });

  it('passes only when every check and every human step is done', () => {
    expect(verdict(green)).toEqual({ passed: true, reasons: [] });
    const open = verdict({
      specsDone: false,
      checksPassed: false,
      taxSignedOff: false,
      reviewerNamed: false,
      criticalOpen: 2,
      cutoverApproved: false,
      parallelRunClean: false,
    });
    expect(open.passed).toBe(false);
    expect(open.reasons).toHaveLength(7);
  });

  const data: ReportData = {
    date: '2026-11-22',
    specs: [{ id: 'P2-01', title: 'Tax | engine', status: 'done' }],
    checks: [{ name: 'Lint', ok: false }],
    tests: { total: 4, passed: 3, failed: 1, skipped: 0, files: 2 },
    coverage: [{ metric: 'lines', pct: 100, covered: 5, total: 5 }],
    findings: [],
    reviewerNamed: false,
    taxSignedOff: false,
    cutoverApproved: false,
    parallelRunClean: false,
    verdict: verdict({ ...green, taxSignedOff: false }),
  };

  it('renders the result, the reasons and the government-data statement', () => {
    const text = renderReport(data);
    expect(text).toContain('## Result: NOT PASSED');
    expect(text).toContain('The accountant has not signed the tax test pack');
    expect(text).toContain('Government data remains prohibited until Gate C');
    expect(text).toContain('| P2-01 | Tax / engine | done |');
    expect(text).toContain('| Lint | FAILED |');
    expect(text).toContain('3 passed, 1 failed');
    expect(text).toContain('| lines | 5 | 5 | 100% |');
  });

  it('renders a passed gate and missing measurements', () => {
    const text = renderReport({
      ...data,
      tests: undefined,
      coverage: undefined,
      reviewerNamed: true,
      taxSignedOff: true,
      cutoverApproved: true,
      parallelRunClean: true,
      verdict: verdict(green),
    });
    expect(text).toContain('## Result: PASSED');
    expect(text).toContain('_Not collected._');
    expect(text).toContain('signed `docs/cutover/tax-signoff.md`');
    expect(text).toContain('0 critical open');
  });
});
