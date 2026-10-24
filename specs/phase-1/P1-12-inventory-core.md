---
id: P1-12
title: Inventory core
phase: 1
module: inventory
status: not-started
depends_on: [P1-11, P1-09, P1-13]
requires_inputs: [H-21]
---

# P1-12 Inventory core

## 1. Purpose
Track stock by store, project ownership (company or client), movements, counts and transfers; issue material to cost objects at the cost supplied by the valuation engine.

## 2. Boundary
- Owns: tables `inv_*`, module `inventory`.
- Provides: `getStockOnHand(storeId, itemId, ownership, ownerPartyId)`, `issueToCostObject(cmd)` (also used by Phase 3 for work orders), `returnToStore(cmd)`, `receiveClientMaterial(cmd)`, `hasIssuesFromGrn(grnId)`, views `inv_v_stock_on_hand`, `inv_v_client_material_balance`, events `stock.issued`, `stock.received`, `stock.adjusted`.
- Consumes: event `goods.received`, valuation (`recordReceipt`, `valueIssue`, `recordTransfer`), projects (`postCost`), master data (items, units), approvals (adjustments), notifications (reorder alerts).
- Must not: compute costs itself (always ask valuation), write cost entries for client-owned stock, or accept negative stock.
- Out of scope: valuation policy and cost layers (P1-13), purchasing (P1-11), vendor bills (P2-05), batch and serial tracking (BACKLOG), landed costs.

## 3. Data model
- `inv_stores(id, code, name, kind warehouse|site, project_id nullable, custodian_user_id, active, ...base)`.
- `inv_ledger(id, store_id, item_id, ownership company|client, owner_party_id nullable, movement_type receipt|issue|transfer_out|transfer_in|adjustment_in|adjustment_out|return_in|salvage_in|client_receipt|client_return, quantity numeric(18,4) signed, unit_cost numeric(18,4) nullable, value numeric(18,2) nullable, cost_object_type nullable, cost_object_id nullable, source_doc_type, source_doc_id, source_line_id, business_date date, posted_at timestamptz, idempotency_key unique, reverses_id nullable)` append-only.
- `inv_balances(store_id, item_id, ownership, owner_party_id, quantity, updated_at)` maintained in the same transaction as ledger inserts; unique on the key columns (owner null for company).
- `inv_transfers(id, number, from_store_id, to_store_id, status draft|in_transit|received|cancelled, ...base)`, `inv_transfer_lines`.
- `inv_counts(id, number, store_id, status draft|counted|approved|cancelled, counted_on)`, `inv_count_lines(count_id, item_id, ownership, owner_party_id, system_qty, counted_qty)`.
- `inv_reorder_levels(store_id, item_id, level)`.

## 4. Business rules
- BR-1 Stock is never negative: any movement that would make a balance negative is refused with the shortfall quantity in the error. The setting `allow_negative_stock` exists but only `false` is accepted in this version.
- BR-2 Receipts from `goods.received` (company-owned, destination store): ledger `receipt` rows at the unit cost from the event; valuation `recordReceipt` is called in the same transaction; the handler is idempotent on the GRN line id.
- BR-3 Issue to a cost object (project): quantity must be positive, store balance sufficient, cost object active; for company stock the valuation engine returns the cost breakdown; one ledger `issue` row per breakdown part (FIFO layers may produce several) and a single project cost entry per issue with status `posted`, cost code taken from the item's default cost code mapping or the command's cost code; for client-owned stock the ledger row has null cost and **no cost entry** is posted.
- BR-4 Transfers: two-leg atomic movement; `in_transit` holds stock out of the source until received; transfers between stores carry the source's cost to the destination through valuation `recordTransfer`; client-owned stock may transfer between stores but keeps ownership and owner.
- BR-5 Client-owned material: `receiveClientMaterial` creates a `client_receipt` with ownership `client` and owner party; `client_return` returns it; the client material balance per project and store is quantity only; reconciliation view shows received, used, returned and balance by item.
- BR-6 Returns from site (`return_in`) restore company stock at the original issue cost via valuation (`recordReturn`); the original project cost is reversed by a negative posted entry linked to the issue.
- BR-7 Salvaged material (`salvage_in`) enters company stock; value per setting H-21 (default zero); it posts a negative cost entry to the project only when the value is non-zero.
- BR-8 Stock adjustments from counts require approval (doc type `stock_adjustment`) and post `adjustment_in` or `adjustment_out`; adjustment-out cost comes from valuation; its loss is posted to the overhead cost object with cost code from setting `stock_loss_cost_code` (must be set before adjustments are allowed).
- BR-9 Business dates follow kernel rules (not future, backdating limit); valuation uses posting sequence, not business date.
- BR-10 Reorder alert: when a store's company stock balance falls below its reorder level after a movement, one notification is sent to storekeeper and procurement, repeated only after the balance rises above the level and falls again.
- BR-11 Concurrency: each movement locks the balance row; two simultaneous issues cannot overdraw (tested with parallel transactions).
- BR-12 Balances always equal the signed sum of ledger quantities for the same key (invariant checker function, used in tests and an admin integrity report).

## 5. API and UI
- `GET /inventory/stores`, `POST /inventory/stores`; `GET /inventory/stock` (filters store, item, ownership); `GET /inventory/ledger`
- `POST /inventory/issues`, `/returns`, `/client-receipts`, `/client-returns`, `/transfers` (+ `/send`, `/receive`), `/counts` (+ `/submit`), `/salvage`
- `GET /inventory/client-material/:projectId`; `GET /inventory/integrity`
- Screens: stock on hand, issue form (mobile friendly), transfer, count sheet, client material reconciliation, ledger viewer.

## 6. Permissions
`inventory.stock.read` (storekeeper, procurement, project_manager, management, accountant; supervisor limited to assigned project stores), `inventory.stock.issue|return|transfer|count` (storekeeper; supervisor issue on assigned project stores if setting `supervisor_can_issue`), `inventory.adjustment.approve` through approvals, `inventory.store.manage` (admin, storekeeper).

## 7. Test requirements
- T-1 Receipt handler idempotency; per-ownership separation of balances.
- T-2 Negative stock refused with exact shortfall; boundary issue of exactly the balance succeeds.
- T-3 Issue cost posting: one project cost entry with `posted` status equal to the valuation value; FIFO multi-layer issue creates multiple ledger rows and one cost entry whose amount equals their sum.
- T-4 Client-owned issue creates no cost entry and null cost; balance and reconciliation view correct.
- T-5 Transfer atomicity, in-transit state machine, cost carried, cancellation restores source.
- T-6 Return reverses the exact original cost; return quantity cannot exceed issued quantity net of previous returns for that issue.
- T-7 Salvage with zero and non-zero value; adjustments with approval and missing loss cost code setting.
- T-8 Reorder alert fires once per crossing.
- T-9 Concurrency test: 10 parallel issues of 5 units against a balance of 30 allow exactly 6 and reject the rest.
- T-10 Property test: after random sequences of valid operations, balances equal the sum of the ledger and total company stock value equals the valuation engine's value (BR-12 and conservation).
- T-11 Route contract tests, repository integration tests, component tests for the issue form; Playwright: GRN to store to issue to project cost; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A GRN into a store increases stock, an issue to a project reduces stock and posts the valued cost to the project ledger.
- AC-2 Client-owned material is tracked by quantity and never appears as company cost.
- AC-3 Stock can never go negative, even under concurrent requests.
- AC-4 The integrity check reports zero differences after the scripted scenario.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-21 (default allowed: salvage value zero). Setting `stock_loss_cost_code` must be configured (needs H-25) before count adjustments are enabled; until then adjustments are refused with a clear message.
