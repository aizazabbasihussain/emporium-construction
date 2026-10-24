---
id: P2-06
title: Subcontractor orders and payments
phase: 2
module: subcontracts
status: not-started
depends_on: [P2-05, P1-09, P1-03]
requires_inputs: [H-03, H-09]
---

# P2-06 Subcontractor orders and payments

## 1. Purpose
Manage trades the company subcontracts (and labour contractors): agree a work order, certify progress, deduct back-charges, withhold tax where applicable, and pay through the payables process with cost recorded on the project.

## 2. Boundary
- Owns: tables `sub_*`, module `subcontracts`.
- Provides: `getWorkOrder`, `getCertifiedAmount(workOrderId)`, events `subcontract.committed`, `subcontract.certified`; registers the bill source `subcontract` with payables.
- Consumes: projects (`postCost`, status, scope), master data (subcontractor parties), approvals, files, payables (`registerBillSource`), tax engine (via payables), inventory (`issueToCostObject` is not used; back-charges for materials supplied are entered as amounts).
- Must not: pay vendors directly or compute tax itself.
- Out of scope: retention (BACKLOG; field reserved and disabled), measurement-based running bills with rate schedules, subcontractor portal (Phase 7).

## 3. Data model
- `sub_work_orders(id, number, project_id, party_id, title, scope_text, contract_amount numeric(18,2), cost_code_id, start_date, end_date, status draft|pending_approval|active|completed|closed|cancelled, retention_percent numeric(9,4) default 0 (must be 0 in this version), ...base)`.
- `sub_work_order_variations(id, work_order_id, amount, reason, status draft|approved|rejected)`.
- `sub_certificates(id, number, work_order_id, certificate_date, basis percent_complete|amount, cumulative_percent numeric(9,4), cumulative_amount numeric(18,2), this_certificate_amount numeric(18,2), deductions numeric(18,2), net_certified numeric(18,2), status draft|pending_approval|certified|billed|cancelled, certified_by, notes)`.
- `sub_back_charges(id, work_order_id, certificate_id nullable, description, amount numeric(18,2))`.

## 4. Business rules
- BR-1 A work order is for an active project and a party with role subcontractor (or labour_contractor); approval through the engine (doc type `subcontract_order`, amount = contract amount); on approval a `committed` cost entry for the contract amount is posted to the project (idempotent), and approved variations add or reduce commitments.
- BR-2 Certificates are cumulative: `cumulative_amount` (or percent x current contract amount) may not exceed the current contract amount including approved variations; `this_certificate_amount` = new cumulative - previous cumulative (must be positive, or zero if only deductions).
- BR-3 Deductions are the sum of back-charges linked to the certificate; net certified = this certificate amount - deductions; net certified cannot be negative.
- BR-4 Certification requires the project manager's approval through the engine (doc type `subcontract_certificate`); on certification the commitment decreases by the certified gross amount and an `approved` cost entry for the gross certified amount is posted; back-charges are recorded as negative `approved` cost entries only when they recover company-incurred costs (flag `recovers_cost`), otherwise they are deductions on the payable only.
- BR-5 Payment: a certified certificate becomes a payables bill of source `subcontract` (net certified as bill base; tax and withholding by the tax engine, withholding rules for subcontractors per H-03); posting the bill moves the cost entries from `approved` to `posted` through payables; the certificate status becomes `billed`.
- BR-6 Completion requires 100% cumulative certification or an approved closing adjustment; closing releases any remaining commitment (reversal entries) and requires no certificates in draft.
- BR-7 Cancelling an active work order requires that nothing has been certified; otherwise only closing is allowed.
- BR-8 Retention is out of scope: any non-zero `retention_percent` is rejected with a message referencing BACKLOG.
- BR-9 Scope: supervisors can view work orders of assigned projects; they cannot see amounts (amount fields hidden unless `subcontracts.amount.read`).

## 5. API and UI
- CRUD `/subcontracts/work-orders`; `POST /subcontracts/work-orders/:id/submit|close|cancel`; variations; `POST /subcontracts/work-orders/:id/certificates`; `POST /subcontracts/certificates/:id/submit|cancel`; back-charges CRUD; `GET /subcontracts/work-orders/:id/ledger`.
- Screens: work order form, certificate screen (cumulative vs previous, deductions), work order ledger (contract, certified, billed, paid), subcontractor statement.

## 6. Permissions
`subcontracts.order.read|create|update|close` (project_manager, management; accountant read), `subcontracts.certificate.create` (project_manager, supervisor draft), approvals via engine, `subcontracts.amount.read` (management, accountant, project_manager).

## 7. Test requirements
- T-1 Commitment and certification math on worked examples (contract 1,000,000, certificates at 30% then 70% cumulative, back-charge 20,000, variation +100,000); property test: cumulative never exceeds contract plus variations and certificate amounts sum to cumulative.
- T-2 Cost ledger effects at each step (committed, then approved, then posted via payables); closing releases the remainder; replay safe.
- T-3 Deduction and net certified rules; negative net refused.
- T-4 State machines for work order and certificate exhaustive; retention non-zero refused.
- T-5 Integration with payables through a fake and the real registry: certified certificate yields a bill with correct base; withholding computed by the engine.
- T-6 Supervisor amount hiding (DTO assertions).
- T-7 Route contract tests, repository integration tests, component tests; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A work order progresses from commitment to certification to a posted, paid bill, with project cost moving committed, approved, posted.
- AC-2 Certification can never exceed the contract plus approved variations.
- AC-3 Back-charges reduce the payable and, where flagged, offset cost.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-03 (withholding on subcontractors: stop if unanswered), H-09 (limits: stop).
