---
id: P3-05
title: Maintenance reports and acceptance
phase: 3
module: service-reports
status: not-started
depends_on: [P3-04]
requires_inputs: []
---

# P3-05 Maintenance reports and acceptance

## 1. Purpose
Give management the maintenance view (open jobs, turnaround, SLA, job profit, warranty cost, repeat visits) and prove the maintenance line works end to end before use.

## 2. Boundary
- Owns: report endpoints in module `reports` extension `service-reports`, end-to-end tests, `docs/maintenance/`.
- Provides: report data and `pnpm gate:maintenance`.
- Consumes: only exported interfaces and published views of service, workorders, billing, receivables, projects, attendance.
- Must not: store financial copies or change module behavior.
- Out of scope: dashboards (Phase 7), contract-based reports (AMC, BACKLOG).

## 3. Data model
None (read-only reports).

## 4. Business rules
- BR-1 **Open jobs:** work orders by status and age, by team, with SLA flags from service requests.
- BR-2 **Turnaround:** request received to completed (hours), by category and priority; averages and 90th percentile; excludes cancelled requests.
- BR-3 **SLA compliance:** percent of requests responded to and resolved within targets, by priority and month.
- BR-4 **Job profit:** per work order and in aggregate: invoiced base, posted and approved cost, margin; non-billable jobs show cost only.
- BR-5 **Warranty cost:** cost of non-billable work orders by project and by category, and in total per month.
- BR-6 **Repeat visits:** clients and sites with two or more requests in the same category within 30 days (setting).
- BR-7 **Technician (team) workload:** worker-days on work orders per team per month.
- BR-8 Same scope, pagination and export rules as the operational reports (P1-19).
- BR-9 Visibility: financial columns only for management and accountant.

## 5. API and UI
- `GET /reports/service/open-jobs|turnaround|sla|job-profit|warranty-cost|repeat-visits|workload` with `format=json|csv|xlsx`.
- Screens: maintenance reports section in the reports hub.

## 6. Permissions
`reports.service.read` (management, service_coordinator operational columns), `reports.service.financial` (management, accountant).

## 7. Test requirements
- T-1 Each report on a scripted maintenance dataset created through the real services, expected figures hand-calculated.
- T-2 Percentile and average calculations with ties and small samples; SLA at boundaries.
- T-3 Repeat-visit logic across the 30-day boundary.
- T-4 Visibility of financial columns.
- T-5 End-to-end (Playwright): request to triage to work order to parts to completion to sign-off to quote or invoice to receipt, with all reports updating.
- T-6 Regression: full Phase 1 and 2 test suites pass (via `pnpm verify`).
- T-7 Route contract tests, component tests; 100% coverage of service and policy.

## 8. Acceptance criteria
- AC-1 The maintenance end-to-end scenario passes with hand-calculated figures.
- AC-2 All reports agree with underlying modules (job profit equals invoice base minus costs).
- AC-3 A maintenance user guide exists in `docs/maintenance/` and UAT is signed by the service coordinator and owner.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
None.
