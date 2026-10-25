---
id: P1-07
title: Job templates and internal estimation
phase: 1
module: estimation
status: done
depends_on: [P1-05]
requires_inputs: [H-15]
---

# P1-07 Job templates and internal estimation

## 1. Purpose
Let the company price lump-sum jobs quickly from reusable templates (boundary wall, room, slab, demolition) and see the internal cost, overhead and expected margin before quoting.

## 2. Boundary
- Owns: tables `est_*`, `packages/domain/estimation`, module `estimation`.
- Provides: `getEstimate(id)` (read model with lines and totals), `lockEstimate(id)`, event `estimate.locked`, query `getEstimateCostLines(id)` used by projects for the budget.
- Consumes: master data (items, cost codes, units, vendor prices, parties for client supply).
- Must not: create quotations or tax; must not read other modules' tables.
- Out of scope: BOQ item-rate tenders and CSR/MRS schedules (not needed: contracts are lump sum), tax (P2-01).

## 3. Data model
- `est_templates(id, code, name, work_type, parameters jsonb [{key,label,unit}], active, ...base)`; `est_template_lines(id, template_id, line_no, description, line_kind material|labour|subcontract|equipment|disposal|salvage_credit, item_id nullable, cost_code_id, unit_code, qty_formula text, default_rate numeric(18,4) nullable, supplied_by company|client)`.
- `est_estimates(id, number, lead_id nullable (plain id reference, no foreign key into `crm_` tables), party_id nullable, title, work_type, sector, status draft|locked|superseded, version, parent_estimate_id nullable, parameters_values jsonb, overhead_percent, contingency_percent, target_margin_percent, proposed_price nullable, ...base)`.
- `est_estimate_lines(id, estimate_id, line_no, description, line_kind, item_id nullable, cost_code_id, unit_code, quantity numeric(18,4), rate numeric(18,4), supplied_by, note)`.
- Computed totals are not stored in lines; `est_estimates` stores `locked_totals jsonb` once locked.

## 4. Business rules
- BR-1 Quantity formulas use a restricted expression language (numbers, template parameters, `+ - * / ( )`, functions `ceil`, `floor`, `round`, `max`, `min`); evaluation uses Decimal, never `eval`; unknown identifiers or division by zero are validation errors.
- BR-2 Creating an estimate from a template instantiates lines by evaluating each formula with the supplied parameter values; the user can then add, edit or remove lines.
- BR-3 Rate defaults: the latest valid vendor price for the item and unit if available, else the template default rate, else zero flagged as `rate_missing`; a draft cannot be locked while any non-client-supplied line is `rate_missing`.
- BR-4 Line total = quantity x rate, rounded half-up to 2 decimals per line.
- BR-5 Company cost = sum of line totals where `supplied_by = company`, treating `salvage_credit` lines as negative cost. Client-supplied lines are shown but excluded from company cost and from the budget.
- BR-6 Overhead amount = company cost x overhead percent; contingency amount = company cost x contingency percent; both rounded half-up. Total estimated cost = company cost + overhead + contingency.
- BR-7 Expected margin = proposed price - total estimated cost; margin percent = expected margin / proposed price (zero price gives null). Target margin shown as a comparison.
- BR-8 Locking freezes lines and computes `locked_totals`; locked estimates are read-only; a revision creates a new version copy (`parent_estimate_id`) and marks the old as `superseded` when the new one locks.
- BR-9 `salvage_credit` lines are allowed only for work types `demolition` and `restructure`.
- BR-10 Templates are versioned by copy; changing a template does not change existing estimates.
- BR-11 Cost code kind must match the line kind (material to material, labour to labour, subcontract to subcontract, equipment to equipment, disposal and salvage_credit to overhead or subcontract as configured by the code's kind).

## 5. API and UI
- CRUD `/estimation/templates`, `/estimation/estimates`; `POST /estimation/estimates/from-template`; `POST /estimation/estimates/:id/lock|revise`; `GET /estimation/estimates/:id/summary`.
- Screens: template editor with formula preview, estimate editor (parameters, lines, live totals computed by the API on save and preview endpoint), margin panel.

## 6. Permissions
`estimation.template.manage` (management, project_manager), `estimation.estimate.read|create|update|lock` (management, project_manager; accountant read).

## 7. Test requirements
- T-1 Formula evaluator: valid expressions, precedence, each function, Decimal precision, unknown identifier, division by zero, injection attempts (strings like `process.exit`, `constructor`) rejected.
- T-2 Instantiation from a boundary-wall template with several parameter sets matches hand-calculated quantities.
- T-3 Cost and margin math with client-supplied lines, salvage credits, overhead and contingency, zero price.
- T-4 Property test: total cost equals the sum of parts for random line sets; changing a client-supplied line never changes company cost.
- T-5 Lock rules (rate missing, read-only after lock), revision and supersede flow, state machine transitions.
- T-6 Salvage credit rule, cost code kind rule.
- T-7 Route contract tests, repository integration tests, component test for the formula preview; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A template with parameters produces an estimate whose totals match the hand-calculated example in the tests.
- AC-2 Client-supplied lines never affect company cost or margin.
- AC-3 A locked estimate cannot be edited; a revision produces version 2 and supersedes version 1 on lock.
- AC-4 No use of `eval` or dynamic code execution anywhere (lint rule plus test).
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-15: job templates and unit rates. Unanswered: ship the editor and evaluator with no real templates; tests use synthetic templates.
