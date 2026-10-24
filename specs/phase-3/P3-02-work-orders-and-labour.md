---
id: P3-02
title: Work orders and labour on jobs
phase: 3
module: workorders
status: not-started
depends_on: [P3-01, P1-17, P1-09, P1-03]
requires_inputs: [H-20]
---

# P3-02 Work orders and labour on jobs

## 1. Purpose
Plan and execute maintenance jobs as work orders: assign a team, schedule, record progress and customer sign-off, and charge labour to the work order through attendance. This spec also enables `work_order` as a cost object.

## 2. Boundary
- Owns: tables `wo_*`, module `workorders`.
- Provides: `getWorkOrder`, `listOpenWorkOrders`, cost object type `work_order` registration, events `workorder.created`, `workorder.completed`, `workorder.signed_off`; view `wo_v_cost_summary`.
- Consumes: service requests, projects (cost ledger `postCost` with cost object `work_order`; enabling flag), attendance (enables `work_order` allocations), workforce (teams), approvals, files.
- Must not: invoice (P3-04), issue stock (P3-03 uses inventory's interface), or change attendance logic beyond enabling the target type.
- Out of scope: preventive schedules, technician mobile app (Phase 6), route optimization, asset registry.

## 3. Data model
- `wo_work_orders(id, number, request_id nullable, party_id, location_id, site_address, title, description, category, billable bool, status draft|scheduled|in_progress|on_hold|completed|signed_off|cancelled, scheduled_start date, scheduled_end date, team_id, lead_worker_id nullable, started_at, completed_at, signed_off_at, signoff_name, signoff_note, estimated_cost nullable, ...base)`.
- `wo_checklist_items(id, work_order_id, line_no, text, done bool, done_at)`.
- `wo_status_history(work_order_id, from, to, at, by, note)`.
- Photos before/after via files with caption `before` or `after`.

## 4. Business rules
- BR-1 Enabling: this spec's migration sets the setting that lets the cost ledger accept `work_order` cost objects (P1-09 BR-11) and lets attendance allocations target `work_order` (P1-17 BR-3); the allocation must reference a work order in status `in_progress` or `scheduled` with a scheduled date range containing the day.
- BR-2 A work order may link to a service request (copying client and site) or be created directly; the billable flag defaults from the request and can only be changed with a reason.
- BR-3 Scheduling assigns a team and date range; a team may have several work orders on one day, but attendance allocation fractions across projects and work orders still sum to 1 per worker-day (enforced by attendance).
- BR-4 Starting requires at least one before photo unless setting `wo_before_photo_required` is false (default true); completing requires at least one after photo and all mandatory checklist items done (items flagged `mandatory`).
- BR-5 Sign-off records the client's name and note and an optional signature image or photo of the signed paper; sign-off is required before invoicing a billable work order and before closing the linked request; it is immutable after recording.
- BR-6 Cost for a work order is the cost ledger entries with cost object `work_order`: labour from attendance (approved status, then posted at payroll finalization), parts from stock issues (P3-03), purchases direct to the job through procurement (project-destined purchases may instead choose a work order as destination when this spec's setting enables it), expenses; `wo_v_cost_summary` shows committed, approved and posted by cost kind.
- BR-7 Cancelling a work order with posted costs is refused; with only approved or committed costs it reverses them with a reason.
- BR-8 Status machine: draft to scheduled to in_progress to on_hold to in_progress to completed to signed_off; cancel from draft, scheduled, on_hold; completed work orders may be reopened to in_progress by the coordinator with a reason before sign-off.
- BR-9 Work orders for non-billable (warranty) jobs still collect cost so warranty cost per project can be reported.

## 5. API and UI
- CRUD `/workorders`; `POST /workorders/:id/schedule|start|hold|complete|signoff|cancel|reopen`; `GET /workorders/:id/cost-summary`; checklist CRUD; `GET /workorders/board`.
- Screens: scheduling board by team and day, work order form with checklist and photos, sign-off dialog, cost summary panel.

## 6. Permissions
`workorders.order.read|create|schedule|cancel|reopen` (service_coordinator, management, project_manager), `workorders.order.execute` (supervisor on assigned teams: start, checklist, photos, complete), `workorders.signoff.record` (supervisor, service_coordinator), `workorders.cost.read` (management, accountant, service_coordinator).

## 7. Test requirements
- T-1 Enabling flag effects: cost ledger accepts `work_order`; attendance accepts `work_order` allocations only for valid statuses and dates (integration with real P1 modules).
- T-2 Allocation split across a project and a work order sums to 1 and posts costs to both.
- T-3 State machine exhaustive; before/after photo and checklist rules; sign-off immutability.
- T-4 Cancellation rules by cost status; reopen rules.
- T-5 Cost summary view numbers against scripted entries.
- T-6 Scope for supervisors; permission matrix additions.
- T-7 Route contract tests, repository integration tests, component tests for the board; Playwright: request to work order to completion; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A work order is scheduled, executed with photos and checklist, completed and signed off.
- AC-2 Labour attendance split between a project and a work order posts to the correct cost objects.
- AC-3 Signed-off work orders are immutable.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-20 (job rules and defaults: stop if the business rules above conflict with the answer).
