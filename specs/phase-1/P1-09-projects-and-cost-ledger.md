---
id: P1-09
title: Projects and cost ledger
phase: 1
module: projects
status: done
depends_on: [P1-08]
requires_inputs: [H-25]
---

# P1-09 Projects and cost ledger

## 1. Purpose
Hold each project (location, sector, contract value, budget, tasks) and the append-only cost ledger every other module posts into, so cost, budget and commitments are visible per project from day one.

## 2. Boundary
- Owns: tables `prj_*`, module `projects`, `packages/domain/costing`.
- Provides: `getProject`, `listProjectsForUser`, `postCost(entry)`, `reverseCost(entryId, reason)`, `transitionCost(entryId, toStatus)`, `getCostSummary(costObject)`, `addBudgetLine(projectId, line)` (used by variations; appends a budget line with source `variation`), `getEstimateBudgetSource`, `isReferenced` for master data, events `project.created`, `project.status.changed`.
- Consumes: event `quotation.accepted`, estimation cost lines (`getEstimateCostLines`), master data (cost codes, parties, locations), identity scopes.
- Must not: contain procurement, stock, payroll or billing logic; it only records costs others post.
- Out of scope: variations (P1-10), contract billing (P2-02), profitability (P2-08); this ledger is not a general ledger.

## 3. Data model
- `prj_projects(id, code, name, party_id, sector, location_id, site_address, status planning|active|on_hold|completed|closed|cancelled, start_date, planned_end_date, actual_end_date, original_contract_value numeric(18,2), quotation_id nullable, estimate_id nullable, project_manager_id, ...base)`.
- `prj_budget_lines(id, project_id, cost_code_id, description, budget_amount numeric(18,2), source estimate|manual, ...base)` unique (project, cost_code, description).
- `prj_cost_entries(id, cost_object_type project|work_order|overhead, cost_object_id nullable, cost_code_id, amount numeric(18,2), status committed|approved|posted|reversed, source_module, source_doc_type, source_doc_id, source_line_id, entry_date, description, idempotency_key unique, reverses_entry_id nullable, created_at, created_by)` append-only.
- `prj_tasks(id, project_id, name, assigned_to_user, start_date, due_date, status todo|doing|done, percent_complete, ...base)`.
- `prj_supervisor_assignments(project_id, user_id, from_date, to_date nullable)` (also writes `sys_user_scopes` through identity interface).
- View `prj_v_cost_summary(cost_object_type, cost_object_id, cost_code_id, committed, approved, posted)`.

## 4. Business rules
- BR-1 Project creation from event `quotation.accepted` is automatic and idempotent (one project per quotation); code from series `PRJ`; contract value = quotation price (the original value is immutable); budget lines are created from the estimate's company-cost lines grouped by cost code; client-supplied lines create no budget.
- BR-2 A `government` project cannot be created unless `ALLOW_GOVERNMENT_DATA=true` (constitution 9); the error is explicit and tested.
- BR-3 Projects may also be created manually (price and client required); manual projects have no estimate and need budget lines added by hand.
- BR-4 Status machine: planning to active to on_hold to active to completed to closed; cancelled from planning or active; closing requires no entries in `committed` status and zero unposted `approved` entries (both listed in the error).
- BR-5 `postCost` rules: amount may be negative only for source kind `salvage` or reversal; cost object must exist and be active (project status active or planning, or completed for warranty-coded entries is not allowed in Phase 1); cost code must be active; idempotency key unique, a repeat returns the existing entry.
- BR-6 Cost entries are never updated except status transitions allowed by the status machine: committed to approved, committed to reversed, approved to posted, approved to reversed, posted to reversed. A transition creates a new ledger row linked via `source_*` and `reverses_entry_id` where needed so the ledger stays append-only; the summary view derives current status per `(source_doc_id, source_line_id)` chain.
- BR-7 Summary: committed + approved + posted amounts are reported separately; `reversed` chains net to zero and are excluded.
- BR-8 Budget variance per cost code = budget - (committed + approved + posted); negative variance flags overspend; no hard block (spending beyond budget is allowed but flagged), configurable warning threshold setting `budget_warning_percent` default 90.
- BR-9 Supervisor assignment creates or ends a `project` scope for the user through the identity interface; ending an assignment does not remove history.
- BR-10 Tasks: percent complete 0-100; status done requires 100; project progress percent = average of task percents weighted equally.
- BR-11 Cost objects of type `work_order` are rejected until Phase 3 enables them (feature flag in settings set by P3-02).

## 5. API and UI
- `GET/POST/PATCH /projects`; `POST /projects/:id/status`; `GET /projects/:id/summary`; `GET/PUT /projects/:id/budget`; `GET/POST /projects/:id/tasks`; `PUT /projects/:id/supervisors`; `GET /projects/:id/cost-entries`.
- Internal interface `postCost` is service-level only (no public route) except an admin manual journal for overhead entries with approval.
- Screens: project list (scoped), project dashboard (contract value, budget vs committed vs approved vs posted, progress), budget editor, tasks board, cost entry drill-down.

## 6. Permissions
`projects.project.read|create|update|status`, `projects.budget.manage` (management, project_manager), `projects.task.manage` (project_manager, supervisor on assigned projects), `projects.cost.read` (management, project_manager, accountant), `projects.cost.post` (system calls only).

## 7. Test requirements
- T-1 Event handling creates exactly one project per quotation (replays and duplicates), budget from estimate grouped by cost code, no budget for client-supplied lines.
- T-2 Government gate with the flag on and off.
- T-3 Status machine exhaustive; closing blocked by committed or unposted approved entries.
- T-4 `postCost` rules: idempotency, inactive cost code, wrong cost object, negative amounts, work_order disabled.
- T-5 Ledger status chains: committed to approved to posted to reversed; summary equals expected for scripted sequences; property test: summary totals equal the sum of entries by chain for random operation sequences, and reversing everything yields zero.
- T-6 Budget variance and warning threshold.
- T-7 Supervisor scope sync with identity.
- T-8 Route contract tests, repository integration tests, component tests for budget editor; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 Accepting a quotation creates a project with contract value and budget lines automatically.
- AC-2 Any module can post a cost through the interface and the summary shows it under the correct status.
- AC-3 A government project is blocked in the cloud environment.
- AC-4 The ledger cannot be edited or deleted by any API or SQL role used by the app.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-25: cost code structure. Unanswered: stop before seeding real cost codes; tests use synthetic codes.
