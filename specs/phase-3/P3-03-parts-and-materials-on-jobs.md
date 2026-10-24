---
id: P3-03
title: Parts and materials on jobs
phase: 3
module: workorder-parts
status: not-started
depends_on: [P3-02, P1-12]
requires_inputs: []
---

# P3-03 Parts and materials on jobs

## 1. Purpose
Let work orders consume stock and direct purchases: issue parts from a store to a work order, return unused parts, mark client-supplied parts, and see the parts cost per job.

## 2. Boundary
- Owns: tables `wop_part_requests` and `wop_part_lines` (prefix `wop_`), module `workorder-parts`.
- Provides: `getPartsForWorkOrder(workOrderId)`; events `workorder.parts.issued`, `workorder.parts.returned`.
- Consumes: inventory (`issueToCostObject`, `returnToStore`, `receiveClientMaterial`, stock on hand), procurement (direct-to-job purchases are out of scope here), workorders status, approvals not used.
- Must not: compute cost (valuation via inventory), write to inventory or cost tables directly.
- Out of scope: van or technician stores (BACKLOG), serial and warranty tracking of parts, purchase of parts through procurement to a work order destination (setting remains disabled in this spec).

## 3. Data model
- `wop_part_requests(id, work_order_id, requested_by, status requested|issued|partly_issued|rejected|cancelled, note, ...base)`.
- `wop_part_lines(id, request_id, item_id, quantity_requested, quantity_issued, quantity_returned, ownership company|client, store_id, issue_ref, unit_cost_snapshot nullable)`.

## 4. Business rules
- BR-1 Parts can be requested only for work orders in status scheduled, in_progress or on_hold; the storekeeper issues from a store with sufficient stock; issue calls inventory `issueToCostObject` with cost object `work_order`; the resulting `posted` cost entry is created by inventory through the cost ledger (this module records references only).
- BR-2 Client-supplied parts use ownership `client`: the storekeeper first receives them with `receiveClientMaterial` against the client, then issues them to the work order at no company cost.
- BR-3 Returns: unused parts return to the store at their original issue cost (inventory/valuation rules); returned quantity cannot exceed issued minus previously returned.
- BR-4 Partial issue is allowed when stock is short: the line becomes `partly_issued`; the shortage is shown to procurement as a pending need (read view).
- BR-5 Completing a work order with parts requests still in `requested` status warns the user; cancelled requests release nothing.
- BR-6 Parts cost on the work order cost summary equals the sum of posted issue entries minus return reversals.

## 5. API and UI
- `POST /workorders/:id/parts-requests`; `POST /parts-requests/:id/issue|return|cancel`; `GET /workorders/:id/parts`; `GET /parts/shortages`.
- Screens: request parts on the work order screen, storekeeper issue queue, returns dialog, shortages list.

## 6. Permissions
`workorders.parts.request` (supervisor, service_coordinator), `workorders.parts.issue|return` (storekeeper), `workorders.parts.read` (service_coordinator, storekeeper, accountant, management).

## 7. Test requirements
- T-1 Issue to a work order posts the valued cost once; summary matches; idempotent replay.
- T-2 Client-supplied part has no cost entry; ownership flows through inventory.
- T-3 Return limits and cost reversal; partial issue and shortage list.
- T-4 Status rules by work order status; completion warning.
- T-5 Property test: parts cost equals issues minus returns for random sequences, using real inventory and valuation under both methods.
- T-6 Route contract tests, repository integration tests, component tests; 100% coverage of service and policy.

## 8. Acceptance criteria
- AC-1 Parts issued to a work order appear in its cost summary at the valued cost; unused parts returned restore stock and cost exactly.
- AC-2 Client-supplied parts never create company cost.
- AC-3 Definition of Done satisfied.

## 9. Open inputs
None.
