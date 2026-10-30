---
id: P1-11
title: Procurement
phase: 1
module: procurement
status: done
depends_on: [P1-09, P1-03, P1-05, P1-04]
requires_inputs: [H-09, H-23]
---

# P1-11 Procurement

## 1. Purpose
Control buying: requisition, quote comparison, purchase order and goods receipt, with approvals and commitments recorded against the project.

## 2. Boundary
- Owns: tables `prc_*`, module `procurement`.
- Provides: `getPurchaseOrder`, `listOpenPoLines`, events `po.approved`, `po.cancelled`, `goods.received` (payload: GRN id, lines with item, quantity, unit cost, destination type store|project, store id or project id, cost code, ownership company), query `getGrn(id)`. Added 2026-10-30 by approved CHANGES entry (P1-19 interfaces), built in the P1-19 PR with tests in this module: `listOpenRequisitions(filter)`.
- Consumes: master data, projects (`postCost`, project status), approvals, files, identity scope.
- Must not: write stock (inventory reacts to `goods.received`) or bills and payments (P2-05).
- Out of scope: vendor bills, three-way match, payment (P2-05), tax (P2-01), landed costs (BACKLOG), purchase returns to vendor (BACKLOG).

## 3. Data model
- `prc_requisitions(id, number, project_id nullable, store_id nullable, requested_by, required_by, status draft|pending_approval|approved|rejected|partly_ordered|ordered|cancelled, note, ...base)`; `prc_requisition_lines(id, requisition_id, item_id, description, quantity, unit_code, cost_code_id, estimated_rate nullable)`.
- `prc_rfqs(id, requisition_id, number, status open|closed)`, `prc_rfq_vendors(rfq_id, vendor_id)`, `prc_quotes(id, rfq_id, vendor_id, valid_until, delivery_days, terms, total numeric(18,2))`, `prc_quote_lines(quote_id, requisition_line_id, rate numeric(18,4))`, `prc_selections(rfq_id, requisition_line_id, quote_id, reason)`.
- `prc_purchase_orders(id, number, version, vendor_id, project_id nullable, store_id nullable, destination_type project|store, order_date, expected_date, status draft|pending_approval|approved|partly_received|received|closed|cancelled, total numeric(18,2), terms, ...base)`; `prc_po_lines(id, po_id, line_no, item_id, description, quantity, unit_code, rate numeric(18,4), line_total numeric(18,2), cost_code_id, received_qty numeric(18,4) default 0)`.
- `prc_grns(id, number, po_id, received_on, received_by, delivery_note_ref, status posted|cancelled, ...base)`; `prc_grn_lines(id, grn_id, po_line_id, accepted_qty, rejected_qty, note)`.

## 4. Business rules
- BR-1 Requisitions must name a project (direct-to-site) or a store (stock replenishment); approval through the engine (doc type `requisition`).
- BR-2 RFQ comparison: at least one quote per selected vendor line; selecting a vendor that is not the lowest rate for a line requires a written reason; comparison view ranks by line rate and by total.
- BR-3 A PO is created from selections or manually; destination is a project (non-stock, direct to site) or a store; line total = quantity x rate rounded half-up to 2 decimals; PO total = sum of line totals.
- BR-4 PO approval through the engine (doc type `purchase_order`, amount = total). On approval, committed cost entries are posted to the project for destination project, one per line, status `committed`, idempotency key `po:<line id>:v<version>`; store-destined POs post no project cost.
- BR-5 PO amendment after approval creates a new version, reverses the old commitments and posts new ones only after re-approval; received quantities are never reduced below what was received.
- BR-6 GRN: accepted quantity per line cannot exceed ordered minus already received plus the over-receipt tolerance (H-23, default 0%); rejected quantity is recorded but not stock or cost.
- BR-7 On GRN posting: for project-destined lines the commitment for the accepted quantity moves to `approved` at the PO rate (cost entry transition) with source GRN; for store-destined lines the event `goods.received` drives inventory; the PO line `received_qty` and PO status update atomically.
- BR-8 A GRN cannot be cancelled once any quantity from it has been issued from stock (checked through inventory's query interface) or if it is referenced by a bill (P2-05); cancellation reverses its cost transitions.
- BR-9 Closing a PO with undelivered quantity releases the remaining commitment (reversal entries).
- BR-10 Only vendors (party role vendor) and active items may be used.
- BR-11 Delivery challan photo is mandatory on a GRN (attachment) unless the setting `grn_photo_required` is false (default true).
- BR-12 Supervisors may raise requisitions and GRNs only for their assigned projects.

## 5. API and UI
- CRUD `/procurement/requisitions`, `/rfqs`, `/quotes`, `/purchase-orders`, `/grns`; action routes for submit, approve via approvals, select-vendor, amend, close, cancel; `GET /procurement/po/:id/print-model`.
- Screens: requisition form, comparison sheet, PO editor and print, GRN receiving screen (mobile friendly), open PO list.

## 6. Permissions
`procurement.requisition.create|read` (supervisor, project_manager, storekeeper, procurement), `procurement.rfq.manage`, `procurement.po.create|read|amend|close` (procurement; management read), `procurement.grn.create|read|cancel` (storekeeper, supervisor limited to assigned projects).

## 7. Test requirements
- T-1 Line total and PO total rounding; property test: PO total equals the sum of line totals for random lines.
- T-2 Comparison and justification rule for non-lowest selection.
- T-3 PO approval posts committed entries exactly once; amendment reverses and re-posts; replay safe.
- T-4 GRN quantity limits with 0% and non-zero tolerance; partial receipts; status transitions of PO (state machine exhaustive).
- T-5 GRN posting: project-destined cost transition committed to approved at PO rate; store-destined emits `goods.received` with correct payload; rejected quantity excluded.
- T-6 GRN cancellation blocked when issued or billed (fake interfaces), allowed otherwise with reversals.
- T-7 PO close releases remaining commitments.
- T-8 Scope enforcement for supervisors; photo-required rule.
- T-9 Route contract tests, repository integration tests, component tests for comparison sheet and GRN; Playwright: requisition to GRN flow; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 Requisition to approved PO to GRN works end to end for a project-destined and a store-destined order.
- AC-2 Commitments appear in the project cost summary after PO approval and move to approved after GRN.
- AC-3 Over-receipt beyond tolerance is refused.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-09 (approval limits: stop if unanswered), H-23 (default 0% over-receipt allowed).
