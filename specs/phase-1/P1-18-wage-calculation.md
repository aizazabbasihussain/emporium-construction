---
id: P1-18
title: Monthly wage calculation
phase: 1
module: wages
status: not-started
depends_on: [P1-17]
requires_inputs: [H-11]
---

# P1-18 Monthly wage calculation

## 1. Purpose
Calculate each worker's monthly pay from approved attendance, overtime, allowances, deductions and advance recoveries, review it, and approve the wage sheet. Payment, payslips and cost finalization follow in P2-07.

## 2. Boundary
- Owns: tables `wag_*`, `packages/domain/wages`, module `wages`.
- Provides: `getApprovedWageSheet(period)`, events `wages.period.approved`, query `getWorkerAdvanceBalance(workerId)`.
- Consumes: attendance (approved attendance, unapproved sheets), workforce (workers, rates), approvals, kernel, files.
- Must not: pay anyone, post to the cash book or alter attendance.
- Out of scope: statutory deductions (fields reserved, disabled: BACKLOG), payslips and payment (P2-07), loan products beyond simple advances.

## 3. Data model
- `wag_periods(id, year, month, status draft|calculated|submitted|approved|reopened, calculated_at, approved_at, ...base)` unique `(year, month)`.
- `wag_lines(id, period_id, worker_id, pay_basis, rate, present_days numeric(6,2), half_days, paid_leave_days, off_days, absent_days, overtime_hours numeric(7,2), basic_pay numeric(18,2), overtime_pay numeric(18,2), allowances numeric(18,2), deductions numeric(18,2), advance_recovery numeric(18,2), gross_pay numeric(18,2), net_pay numeric(18,2), rounding_adjustment numeric(18,2), note)`.
- `wag_adjustments(id, line_id, kind allowance|deduction, amount numeric(18,2), reason, added_by)`.
- `wag_advances(id, worker_id, amount, issued_on, monthly_recovery numeric(18,2), status open|closed, ...base)`; `wag_advance_recoveries(advance_id, period_id, amount)`.

## 4. Business rules
- BR-1 Calculation reads only approved attendance entries in the calendar month; days counted: present = 1, half_day = 0.5, paid leave, off, absent.
- BR-2 **Daily-rate workers:** basic pay = (present days + half-day fractions) x daily rate in effect on each day (computed per day, so mid-month rate changes apply from their effective date); off days and leave are unpaid unless setting `pay_off_days_daily` is true (default false).
- BR-3 **Monthly-salary workers:** basic pay = salary / working-days basis x payable days, where payable days = present + 0.5 x half days + paid leave + off days, capped at the basis (H-11); rate in effect per day applies proportionally across a mid-month change.
- BR-4 Overtime pay = sum over days of hours x (daily-equivalent rate / 8) x multiplier (H-11).
- BR-5 Gross = basic + overtime + allowances; net = gross - deductions - advance recovery; net pay may not be negative: if deductions plus recovery exceed gross, the advance recovery is reduced first (carried to the next month) and any remaining shortfall is flagged for manual decision.
- BR-6 Advance recovery for a worker in a period = min(monthly_recovery, open advance balance, gross - deductions); balances update only when the period is approved; reopening reverses the recoveries.
- BR-7 Rounding: all amounts half-up to 2 decimals per component; net pay is rounded to the nearest rupee if setting `round_net_to_rupee` is true (H-11); the difference is stored in `rounding_adjustment`.
- BR-8 Recalculation is idempotent and replaces calculated values but keeps manual adjustments; calculating an approved period is refused (reopen first).
- BR-9 Submission is blocked while any attendance sheet in the month is unapproved (listed in the error); days with no sheet are shown as warnings the approver acknowledges (not blocking).
- BR-10 Manual allowances and deductions require a reason, are audited, and may be added only while the period is `calculated` or `reopened`.
- BR-11 Approval through the engine (doc type `wage_period`, amount = total net pay); on approval the period locks, advance balances update, and `wages.period.approved` is emitted once. Reopening requires `wages.period.reopen` and a reason, and is blocked once P2-07 has paid any line.
- BR-12 Reconciliation report: attendance-allocated labour cost (from the cost ledger, approved status) vs wage-sheet gross by worker and in total, with differences listed (consumed by P2-07).

## 5. API and UI
- `POST /wages/periods` (create for month), `POST /wages/periods/:id/calculate|submit|reopen`; `GET /wages/periods/:id/lines`; `POST /wages/lines/:id/adjustments`; `GET /wages/periods/:id/reconciliation`; advances: `POST /wages/advances`, `GET /wages/advances`.
- Screens: wage sheet grid with drill-down per worker, warnings panel, adjustments dialog, advances list, reconciliation view, printable wage sheet.

## 6. Permissions
`wages.period.read|calculate|submit` (accountant, management), `wages.adjustment.manage` (accountant), `wages.period.reopen` (management), `wages.advance.manage` (accountant). Supervisors have no access.

## 7. Test requirements
- T-1 Worked examples: daily-rate worker with 24 present days at 1,000 plus 2 half days gives 25,000; salary worker 26,000 on basis 26 with 2 absent days gives 24,000; OT examples; mid-month rate change split.
- T-2 Basis 26 vs 30 behavior; cap at basis; off-day setting.
- T-3 Advance recovery limits and negative-net handling, recovery carry-over.
- T-4 Rounding to nearest rupee and `rounding_adjustment`.
- T-5 Idempotent recalculation keeps manual adjustments; approved period refuses recalculation; reopen reverses recoveries.
- T-6 Submission blocked by unapproved sheets; warning for missing sheets acknowledged.
- T-7 Property tests: net = gross - deductions - recovery for random inputs; sum of lines equals period totals; calculating twice gives identical results.
- T-8 Reconciliation: allocated cost vs gross differences for scripted data.
- T-9 Route contract tests, repository integration tests, component tests for the sheet grid; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A month of synthetic attendance for 50 workers produces a wage sheet matching an independently computed spreadsheet (test fixture) to the paisa.
- AC-2 The wage period can be approved, and approved attendance for that month can no longer be unlocked.
- AC-3 Advance balances update only on approval.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-11: working-days basis, overtime multiplier, net rounding. Open; proceed with the register default (basis 26, overtime x1.5, net rounded to PKR 1) as editable settings and record it in the PR.
