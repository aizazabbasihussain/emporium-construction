---
id: P2-07
title: Payroll finalization, payment and payslips
phase: 2
module: payroll
status: not-started
depends_on: [P1-18, P2-03, P1-09]
requires_inputs: [H-29, H-09]
---

# P2-07 Payroll finalization, payment and payslips

## 1. Purpose
Turn the approved monthly wage sheet into payments and payslips, confirm labour cost on projects, and reconcile attendance-allocated cost with what was actually paid.

## 2. Boundary
- Owns: tables `pyr_*`, module `payroll`.
- Provides: `getPayrollRun(periodId)`, `getUnpaidWages()`, events `payroll.finalized`, `payroll.paid`.
- Consumes: wages (approved sheet, reconciliation), cash book (`recordPayment`), projects (`transitionCost`, `postCost`), approvals, files, kernel numbering.
- Must not: recalculate wages (wages module is the only calculator) or change attendance.
- Out of scope: statutory deductions and filings (BACKLOG), bank file formats, mobile wallet integrations, final settlement of leavers.

## 3. Data model
- `pyr_runs(id, period_id unique, status draft|finalized|part_paid|paid, finalized_at, total_net numeric(18,2), total_paid numeric(18,2), cost_difference_treatment spread_to_projects|overhead, ...base)`.
- `pyr_lines(id, run_id, worker_id, net_pay numeric(18,2), payment_method cash|bank_transfer|wallet, payment_status unpaid|paid, paid_on, cashbook_txn_id nullable, payslip_number, note)`.
- `pyr_cost_adjustments(id, run_id, project_id, amount numeric(18,2), ledger_entry_id)`.

## 4. Business rules
- BR-1 A run can be created only for a wage period in status `approved`; one run per period; finalizing locks the run and emits `payroll.finalized` once.
- BR-2 **Cost finalization:** for each project and worker, the labour cost entries in status `approved` for that month are moved to `posted`; the difference between wage-sheet gross and total allocated attendance cost (positive or negative) is spread to the projects of the month pro-rata to their allocated cost (H-29 default), or posted to overhead if the treatment is `overhead`; spread uses the largest-remainder method so that adjustments sum exactly to the difference (to the paisa); entries have source `payroll`.
- BR-3 Payslips: one per worker per run with a number from series `PSL`, showing basic, overtime, allowances, deductions, advance recovery, net, and attendance summary; no other worker's data; rates shown only on the worker's own payslip; a run-level payslip PDF set is produced on demand.
- BR-4 Payment: lines are marked paid individually or in bulk with a payment date, method and source cash account; each payment records a cash book payment (grouped per method and account to one transaction with the line list in the reference, or per line when setting `payroll_cash_txn_per_line` is true); a payment over the approval band for the run total needs approval (doc type `payroll_payment`); the user who finalizes cannot approve the payment.
- BR-5 A paid line cannot be unpaid; reversing a payment requires a reversal in the cash book with a reason and `payroll.payment.reverse`.
- BR-6 Unpaid wages report: lines unpaid by run and age; the run status becomes `part_paid` then `paid` automatically.
- BR-7 Finalized runs are immutable; corrections for the next month go through wage adjustments in the next period, not by reopening a paid run; reopening an unpaid finalized run is allowed only with `payroll.run.reopen`, which reverses the cost finalization entries.
- BR-8 Sensitive data (bank, wallet info) is visible only to the accountant and masked in payment lists.

## 5. API and UI
- `POST /payroll/runs` (from period); `POST /payroll/runs/:id/finalize|reopen`; `GET /payroll/runs/:id/lines`; `POST /payroll/runs/:id/pay` (selection and method); `GET /payroll/runs/:id/payslips.pdf`; `GET /payroll/payslips/:id`; `GET /payroll/unpaid`.
- Screens: payroll run with payment grid, payslip viewer and print, unpaid wages, cost difference summary.

## 6. Permissions
`payroll.run.read|create|finalize` (accountant; management read), `payroll.payment.create` (accountant), `payroll.payment.reverse` (management), `payroll.run.reopen` (management), `payroll.payslip.read` (accountant, management).

## 7. Test requirements
- T-1 Cost finalization: approved entries become posted for exactly the month's labour; difference spread to the cent with the largest-remainder method; property test: spread amounts sum exactly to the difference for random project shares.
- T-2 Overhead treatment variant; zero difference variant.
- T-3 Payment flows: bulk, partial, per-line cash txn setting; cash book called once per group; approval band and separation of duties.
- T-4 Run state machine exhaustive; reopen reverses cost finalization only when unpaid.
- T-5 Payslip content and privacy (only own data; rate visibility).
- T-6 Unpaid report and status transitions.
- T-7 Idempotent event handling for `payroll.finalized`.
- T-8 Route contract tests, repository integration tests, component tests; Playwright: approved wage sheet to paid run; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 An approved wage period becomes a finalized run; project labour costs show `posted` and match the wage sheet gross in total.
- AC-2 Payslips generate for all 50 synthetic workers.
- AC-3 Payments reduce cash book balances exactly by the amounts paid.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-29 (default spread to projects allowed), H-09 (approval band for payroll payments: stop if unanswered).
