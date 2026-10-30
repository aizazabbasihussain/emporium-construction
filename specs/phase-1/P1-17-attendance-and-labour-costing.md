---
id: P1-17
title: Attendance and labour costing
phase: 1
module: attendance
status: done
depends_on: [P1-16, P1-09, P1-03]
requires_inputs: [H-11]
---

# P1-17 Attendance and labour costing

## 1. Purpose
Supervisors record daily attendance for their team, assigning each worker's day to a project; approved attendance allocates labour cost to projects.

## 2. Boundary
- Owns: tables `att_*`, `packages/domain/attendance`, module `attendance`.
- Provides: `getApprovedAttendance(workerId, from, to)`, `getAttendanceHeadcount(projectId, date)`, `getUnapprovedSheets(period)`, events `attendance.approved`, `attendance.unlocked`.
- Consumes: workforce (teams, members, rates), projects (`postCost`, status, scope), approvals, kernel.
- Must not: compute payroll (P1-18) or edit worker records.
- Out of scope: biometric devices, geofencing, leave balances, work-order allocation (enabled by P3-02), overtime approval workflows beyond the sheet approval.

## 3. Data model
- `att_sheets(id, team_id, sheet_date, status draft|submitted|approved|rejected|unlocked, submitted_by, submitted_at, approved_by, approved_at, ...base)` unique `(team_id, sheet_date)`.
- `att_entries(id, sheet_id, worker_id, status present|half_day|absent|leave_paid|leave_unpaid|off, overtime_hours numeric(5,2) default 0, remarks, day_value numeric(18,2) nullable)`.
- `att_allocations(id, entry_id, cost_object_type project, cost_object_id, fraction numeric(5,4), cost_code_id)`.
- Unique `(worker_id, date)` is enforced across sheets through an `att_worker_days(worker_id, work_date)` table.

## 4. Business rules
- BR-1 A sheet date cannot be in the future and may be at most the backdating allowance in the past; only the team's supervisor (or an office role with `attendance.sheet.create`) can create it.
- BR-2 Entries are limited to workers who are members of the team on that date; a worker can appear in only one sheet per date (a worker moved mid-day is entered by the team they belong to at day start).
- BR-3 `present` and `half_day` entries require allocations whose fractions sum to exactly 1 (a half day is still allocated across 100% of the day it represents); `absent`, `leave_*` and `off` have none. Allocation targets must be active projects the supervisor is scoped to; cost code defaults to the project's labour cost code (setting `labour_cost_code`).
- BR-4 Day value: `present` = 1.0 x daily-equivalent rate; `half_day` = 0.5 x daily-equivalent rate; paid leave and off carry no project cost in this module (they matter for wages in P1-18). The daily-equivalent rate comes from `getWorkerRate(worker, date)`; a missing rate blocks submission with the worker's name.
- BR-5 Overtime cost = `overtime_hours` x (daily-equivalent rate / 8) x overtime multiplier (H-11); overtime is allocated to the worker's first allocation's project unless an explicit overtime project is given. Overtime hours are limited to 0-8 per day per entry.
- BR-6 Submission goes to the approval engine (doc type `attendance_sheet`, amount = total labour cost of the sheet); on approval the system posts cost entries to the cost ledger per entry and allocation (worker-day-project), status `approved`, idempotency key `att:<entry>:<alloc>`, amounts = day value x fraction + overtime part; amounts rounded half-up to 2 decimals per entry-allocation line.
- BR-7 Approved sheets are locked. An authorized user can request an unlock with a reason (`unlocked` status); unlocking reverses the sheet's cost entries; resubmission and re-approval posts new entries. A sheet cannot be unlocked if its month's wage period has been approved in P1-18 (error names the period).
- BR-8 A sheet rejected by the approver returns to the supervisor with a mandatory comment.
- BR-9 `getUnapprovedSheets(period)` lists team-dates with sheets not approved, and active team-dates (weekdays, excluding `site_holidays`) with no sheet at all, for P1-18 to warn about.
- BR-10 Bulk entry grid: the API accepts a whole sheet in one request (all entries and allocations) and validates it atomically.

## 5. API and UI
- `GET /attendance/sheets?team&date`; `PUT /attendance/sheets/:team/:date` (upsert draft with entries); `POST /attendance/sheets/:id/submit|unlock`; approval through approvals; `GET /attendance/missing?from&to`
- Screens: attendance grid per team and date (rows workers, columns status, project split, OT), my teams' sheets, missing sheets, approval view for project manager.

## 6. Permissions
`attendance.sheet.create|update` (supervisor on own teams, project_manager), `attendance.sheet.read` (supervisor own, project_manager, management, accountant), `attendance.sheet.unlock` (management, project_manager), approval via engine.

## 7. Test requirements
- T-1 Allocation rules: sums exactly 1, rounding to 4 decimals, rejects 0.999, rejects allocations on absent.
- T-2 Day value and overtime formulas for daily-rate and salary workers using worked examples (rate 1,000 per day: present 1,000; half day 500; OT 2 hours at multiplier 2 = 500); property test: total cost of a sheet equals the sum of its entry-allocation lines for random inputs.
- T-3 One-sheet-per-worker-per-date uniqueness; membership by date; mid-month team change.
- T-4 Cost posting on approval (entries, statuses, idempotent replay); unlock reverses exactly; re-approval posts again; locked after wage approval.
- T-5 State machine exhaustive; rejection with comment.
- T-6 Missing-sheet detection with holidays and weekends.
- T-7 Scope enforcement and backdating rules.
- T-8 Atomic bulk upsert (one invalid entry rejects all).
- T-9 Route contract tests, repository integration tests, component tests for the grid; Playwright: supervisor fills a sheet and manager approves; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A team's daily sheet is submitted and approved; labour cost appears on the right projects with status `approved`.
- AC-2 Splitting a worker's day across two projects divides cost exactly.
- AC-3 Unlocking an approved sheet reverses its cost; re-approval posts the corrected cost.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-11: working-days basis and overtime multiplier. Open; proceed with the register default (basis 26, overtime x1.5, net rounded to PKR 1) as editable settings and record it in the PR.
