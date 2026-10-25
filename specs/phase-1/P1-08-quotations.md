---
id: P1-08
title: Quotations (lump sum)
phase: 1
module: quotations
status: done
depends_on: [P1-07, P1-03, P1-06]
requires_inputs: [H-09]
---

# P1-08 Quotations (lump sum)

## 1. Purpose
Issue lump-sum quotations to clients with scope, inclusions, exclusions and a payment-stage schedule, enforce a margin floor through approval, and hand an accepted quotation to the project module.

## 2. Boundary
- Owns: tables `qte_*`, module `quotations`, quotation print model and PDF.
- Provides: `getQuotation(id)`, event `quotation.accepted` (carries quotation id, estimate id, party id, sector, location, contract value, stage schedule), event `quotation.issued`.
- Consumes: estimation (locked estimate totals), approvals, CRM (lead), master data, files.
- Must not: compute tax (price is shown excluding tax until P2-01 supplies tax lines); must not create projects (P1-09 reacts to the event).
- Out of scope: tender documents, item-rate quotations, tax lines (P2-01 and P2-02).

## 3. Data model
- `qte_quotations(id, number, version, parent_id nullable, lead_id nullable, estimate_id, party_id, title, sector, location_id, scope_text, inclusions text, exclusions text, terms text, validity_days, price numeric(18,2), status draft|pending_approval|approved|issued|accepted|rejected|expired|superseded, issued_at, accepted_at, expires_on, ...base)`.
- `qte_stages(id, quotation_id, stage_no, name, basis percent|amount, percent numeric(9,4), amount numeric(18,2), condition_text)`.
- `qte_status_history(quotation_id, from, to, at, by, note)`.

## 4. Business rules
- BR-1 A quotation is created from a locked estimate; its `price` defaults to the estimate's proposed price and must be greater than zero.
- BR-2 Margin check at submission: margin percent = (price - total estimated cost) / price. If it is below the margin floor (from approval rule context, H-09) the approval engine is used with doc type `quotation`; if at or above the floor, the engine still runs for amounts under rule bands that require approval; no rule matching is an error.
- BR-3 Stage schedule: stage percents must sum to exactly 100 (or stage amounts to the price); at least one stage; amounts derive from percent using half-up rounding with the remainder added to the last stage so the total equals the price exactly.
- BR-4 Statuses follow the state machine: draft to pending_approval to approved to issued to accepted or rejected or expired; issued quotations are read-only; editing requires a revision (new version, old becomes superseded when the new is issued).
- BR-5 Validity: `expires_on = issued_at date + validity_days`; a daily job marks issued quotations past expiry as `expired`.
- BR-6 Acceptance records who accepted and date (client acceptance document attached through files is mandatory for sector `government`, optional for private); acceptance emits `quotation.accepted` once.
- BR-7 Number series `QTE` with `/<version>` suffix on revisions.
- BR-8 The print model contains company profile, registrations, client, scope, inclusions, exclusions, stage schedule, terms and the price; internal cost and margin never appear in the print model (tested).
- BR-9 PDF generation uses the print model; a golden-file test pins the model, not the binary bytes.
- BR-10 Rejection requires a reason; a rejected quotation can be revised.

## 5. API and UI
- CRUD `/quotations`; `POST /quotations/:id/submit|issue|accept|reject|revise`; `GET /quotations/:id/print-model`; `GET /quotations/:id/pdf`.
- Screens: quotation editor (price, margin panel visible to authorized users only, stage schedule), approval status, print preview, acceptance dialog.

## 6. Permissions
`quotations.quotation.read|create|update|submit|issue|accept|reject` (management, project_manager; accountant read). `quotations.margin.read` (management, accountant only).

## 7. Test requirements
- T-1 Stage schedule rounding: percents summing to 100 and amounts equal price exactly for 1,000 random prices and stage splits (property test); rejection when sums differ.
- T-2 Margin calculation and approval routing at the floor boundary; no matching rule error.
- T-3 State machine exhaustive; revision and supersede behavior.
- T-4 Expiry job with fixed clock at boundary (expires_on inclusive).
- T-5 Government acceptance requires attachment; private does not.
- T-6 `quotation.accepted` emitted once; payload contents.
- T-7 Print model excludes internal cost and margin (assertions on every field name).
- T-8 Route contract tests, repository integration tests, component tests for stage editor; 100% coverage of service, policy and domain.

## 8. Acceptance criteria
- AC-1 A quotation from a locked estimate is approved, issued, accepted and emits `quotation.accepted` with the stage schedule.
- AC-2 Stage amounts always add up to the price to the paisa.
- AC-3 Internal cost and margin never appear in any print output.
- AC-4 Quotations expire automatically.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-09: margin floor and approval bands. Unanswered: stop.
