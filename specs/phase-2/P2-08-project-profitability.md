---
id: P2-08
title: Project profitability and contract tracking
phase: 2
module: profitability
status: not-started
depends_on: [P2-04, P2-05, P2-06, P2-07, P1-09]
requires_inputs: []
---

# P2-08 Project profitability and contract tracking

## 1. Purpose
Show, per project, contract value against cost, billing and cash collected, so the owner sees true margin, receivables exposure and cash position on every job.

## 2. Boundary
- Owns: tables `pft_*` (alert settings only), module `profitability`.
- Provides: `getProjectFinancials(projectId, asOf)`, `listProjectFinancials(filters)`, event `profitability.alert.raised`.
- Consumes: projects (current contract value, budget, cost summary), billing (billed net of credit notes), receivables (collected), payables and subcontracts (paid amounts), payroll (paid wages), cash book (project-tagged payments through source documents).
- Must not: store copies of financial data except alert state and saved forecasts; must not read other modules' tables directly.
- Out of scope: general ledger statements, tax profitability, maintenance job profit (P3-05 adds work-order profit through the same cost summary interface), forecasting models beyond cost-to-complete.

## 3. Data model
- `pft_thresholds(id, scope company|project, project_id nullable, margin_floor_percent, overspend_percent, receivable_age_days, active)`.
- `pft_forecasts(id, project_id, cost_to_complete numeric(18,2), note, forecast_date, set_by)` latest per project is used.
- `pft_alert_state(project_id, alert_code, raised_at, cleared_at)`.

## 4. Business rules
- BR-1 Definitions per project as of a date: **Contract value** (original + approved variations); **Billed** (issued invoices net of credit notes, base amount excluding tax); **Collected** (receipts allocated to the project's invoices, including withheld tax certified, excluding tax in amounts reported separately: reported as gross collected and base collected); **Outstanding receivable** = billed gross - collected gross; **Cost** by status (committed, approved, posted) from the cost ledger; **Paid out** = vendor payments + subcontractor payments + payroll paid + expenses reimbursed that are attributable to the project (through source document links).
- BR-2 **Expected margin** = contract value - (cost to date + cost to complete), where cost to complete = the latest manual forecast if set, else max(0, budget total - (committed + approved + posted)); **current margin** = billed base - posted cost - approved cost; both shown with percent of contract value or billed; the two are always labelled so posted, approved and committed are never blended silently.
- BR-3 **Cash position** = collected gross - paid out; negative means the company has funded the project.
- BR-4 Alerts raised when: margin percent below floor, total cost used above overspend percent of budget, a receivable older than the age limit exists; an alert is raised once and cleared when the condition is no longer true; notification goes to project manager and management.
- BR-5 The project list shows contract value, billed percent, collected percent, cost percent of budget, margin, cash position, sorted by risk.
- BR-6 Everything is computed from the owning modules' interfaces at read time (or from their published views); there is no stored copy that can drift; results are reproducible for any `asOf` date that the sources support.
- BR-7 Amounts are Decimal; percent calculations round half-up to 2 decimals; division by zero yields null, not an error.
- BR-8 Visibility: management, accountant and the project manager of the project; supervisors have no access.
- BR-9 Export to XLSX and CSV through the shared export helper with the report header block.

## 5. API and UI
- `GET /profitability/projects`, `GET /profitability/projects/:id?asOf=`; `PUT /profitability/projects/:id/forecast`; thresholds CRUD.
- Screens: portfolio table with risk sorting, project financial page (contract, billed, collected, receivable, cost by status, margin, cash position, forecast), alert list.

## 6. Permissions
`profitability.read` (management, accountant, project_manager for own projects), `profitability.forecast.set` (project_manager, management), `profitability.threshold.manage` (management).

## 7. Test requirements
- T-1 A scripted project (contract 1,000,000, variation +100,000, invoices, credit note, receipts including withheld tax, bills, payroll, subcontract certificate) with every figure hand-calculated and asserted.
- T-2 Margin and cost-to-complete with and without a manual forecast; zero budget and zero billed (nulls).
- T-3 Alert raise and clear transitions with a fixed clock; no duplicate alerts.
- T-4 As-of reproducibility: figures at an earlier date ignore later transactions.
- T-5 Property tests: cash position = collected - paid out for random sequences; cost status totals equal the cost ledger summary.
- T-6 Visibility rules; boundary test (imports only through index files).
- T-7 Route contract tests, component tests; 100% coverage of service, policy and domain.

## 8. Acceptance criteria
- AC-1 The scripted project's figures match the worksheet to the paisa.
- AC-2 Alerts trigger and clear as thresholds are crossed.
- AC-3 No stored copy of cost or billing data exists in `pft_` tables.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
None.
