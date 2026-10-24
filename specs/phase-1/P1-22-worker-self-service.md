---
id: P1-22
title: Worker self-service login
phase: 1
module: workerportal
status: not-started
depends_on: [P1-02, P1-16, P1-17, P1-18]
requires_inputs: []
---

# P1-22 Worker self-service login

## 1. Purpose
Let a labourer log in on a phone and see only their own records: attendance, advances and wage lines. Approved by the owner (H-10 answer); not part of Gate A (P1-21).

## 2. Boundary
- Owns: table `wkp_worker_accounts`, module `workerportal`, the worker screens.
- Provides: role `worker`, route group `/me/worker/*`.
- Consumes: identity (`registerRole`, `registerPermissions`, `currentUser()`), workforce (`getWorker`), attendance (`getApprovedAttendance`), wages (`getApprovedWageSheet`, `getWorkerAdvanceBalance`), kernel audit.
- Must not: show another worker's data, any rate of another worker, project financials, or any write action; let a worker create their own login.
- Out of scope: payslip PDFs and payment (P2-07), leave requests, chat.

## 3. Data model
- `wkp_worker_accounts(user_id pk, worker_id unique, linked_by, linked_at)`; a user links to exactly one worker record and a worker to at most one user.

## 4. Business rules
- BR-1 Only an admin links or unlinks a user to a worker (permission `workerportal.account.manage`); linking requires the user to hold only the `worker` role unless the admin confirms otherwise; every link change is audited.
- BR-2 Every `/me/worker/*` query takes the worker id from the link of the authenticated user, never from the request. A user with no link gets 403.
- BR-3 A worker sees: their approved attendance by month; their own advance balance and recoveries; their approved wage lines (days, overtime, deductions, advance recovery, net pay) only for periods whose wage sheet is approved. Unapproved sheets and drafts are never visible.
- BR-4 A disabled or inactive worker (`left_on` set) loses access to `/me/worker/*` at the end of the left date.
- BR-5 The UI shows no navigation to any other module; the API enforces the same limits in policy code, not only in the UI.

## 5. API and UI
- `GET /me/worker/attendance?month=`, `GET /me/worker/advances`, `GET /me/worker/wages?month=`; `PUT /admin/workers/:id/account` (link), `DELETE /admin/workers/:id/account`.
- Screens: three read-only pages in a phone-first layout, worker link control on the worker profile.

## 6. Permissions
`workerportal.self.read` (role `worker`), `workerportal.account.manage` (admin).

## 7. Test requirements
- T-1 Policy: worker A cannot read worker B by changing ids, query strings or headers (every route).
- T-2 Unlinked user gets 403; a user who holds a role besides `worker` follows BR-1.
- T-3 Only approved wage sheets appear; a sheet that becomes unapproved disappears.
- T-4 Inactive worker loses access per BR-4.
- T-5 Component tests for the three screens; one end-to-end test: worker logs in and sees own attendance only.
- T-6 100% coverage on service and policy code.

## 8. Acceptance criteria
- AC-1 A linked worker sees their own attendance, advances and approved wage lines and nothing else (T-1, T-5).
- AC-2 No route under `/me/worker` accepts a worker id parameter (T-1).
- AC-3 Link changes appear in the audit log (BR-1).
- AC-4 Definition of Done satisfied.

## 9. Open inputs
None.
