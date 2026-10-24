---
id: P1-10
title: Project variations
phase: 1
module: variations
status: not-started
depends_on: [P1-09, P1-03, P1-04]
requires_inputs: [H-09]
---

# P1-10 Project variations

## 1. Purpose
Record changes in scope discovered during the job (common in renovation and demolition), get client approval, and adjust the contract value and budget without losing the original contract.

## 2. Boundary
- Owns: tables `var_*`, module `variations`.
- Provides: `getCurrentContractValue(projectId)`, `listApprovedVariations(projectId)`, events `variation.approved`, `variation.rejected`.
- Consumes: projects (project status, budget lines through interface `addBudgetLine`), approvals, files, master data.
- Must not: edit `original_contract_value` or write to project tables directly.
- Out of scope: billing of variations (P2-02), tax (P2-01).

## 3. Data model
- `var_variations(id, project_id, number, title, reason text, discovered_on, status draft|pending_internal_approval|submitted_to_client|client_approved|client_rejected|cancelled, price_impact numeric(18,2), cost_impact numeric(18,2), client_approval_ref, client_approved_on, ...base)`.
- `var_lines(id, variation_id, description, cost_code_id, cost_amount numeric(18,2), price_amount numeric(18,2))`.

## 4. Business rules
- BR-1 A variation belongs to one project in status `active`; numbers from series `VAR` per project (`<project code>-V<n>`).
- BR-2 `price_impact` and `cost_impact` equal the sums of line amounts; a variation needs at least one line; price impact may be negative (deductive variation).
- BR-3 Internal approval through the approval engine (doc type `variation`) before it can be sent to the client.
- BR-4 Client approval requires a reference and date and an attached document (client letter or signed form); approval date cannot be in the future.
- BR-5 On `client_approved`: current contract value = original + sum of approved price impacts; each line's cost amount is added to the project budget through `addBudgetLine` with source `variation`; the event `variation.approved` is emitted once.
- BR-6 A client-approved variation cannot be edited or deleted; reversing it requires a new deductive variation.
- BR-7 `client_rejected` and `cancelled` are terminal; a rejected variation can be copied into a new draft.
- BR-8 Work started before approval is allowed but flagged: costs posted to the project after `discovered_on` and before approval are reported as "at risk" in the variation summary (sum of posted and approved costs whose cost code matches variation lines).

## 5. API and UI
- CRUD `/projects/:id/variations`; `POST /variations/:id/submit-internal|send-to-client|client-approve|client-reject|cancel`; `GET /projects/:id/contract-value`.
- Screens: variation list per project, editor with lines, approval timeline, "at risk" panel.

## 6. Permissions
`variations.variation.read|create|update` (project_manager, management; supervisor create draft on assigned projects), `variations.variation.client-approve` (project_manager, management).

## 7. Test requirements
- T-1 Impact totals from lines including negative lines.
- T-2 State machine exhaustive; approval engine integration; client approval needs reference, date, attachment.
- T-3 Contract value after several approved variations including a deductive one; original value unchanged.
- T-4 Budget lines added exactly once on approval; replay of the event is safe.
- T-5 At-risk calculation with a fixed clock and sample ledger entries.
- T-6 Approved variations immutable.
- T-7 Route contract tests, repository integration tests, component tests; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 An approved variation raises the current contract value and adds budget lines; the original value is unchanged.
- AC-2 A variation cannot be sent to the client without internal approval.
- AC-3 Costs posted before approval appear as at risk.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-09: approval limits for variations. Unanswered: stop.
