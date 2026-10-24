---
id: P1-13
title: Stock valuation engine (configurable)
phase: 1
module: valuation
status: not-started
depends_on: [P1-05]
requires_inputs: [H-07]
---

# P1-13 Stock valuation engine (configurable)

## 1. Purpose
Decide what cost is attached to stock when it is received and issued. The method is configurable: a company default with optional per-category overrides, using weighted average or FIFO, effective-dated and changeable later through an approval-controlled transition that preserves total stock value.

## 2. Boundary
- Owns: tables `val_*`, `packages/domain/valuation`, module `valuation`.
- Provides: `recordReceipt`, `valueIssue`, `recordTransfer`, `recordReturn`, `getStockValue(storeId, itemId)`, `getTotalValue(filters)`, `resolvePolicy(itemId, date)`, `setPolicy`, `requestTransition`, events `valuation.policy.changed`, `valuation.transition.completed`.
- Consumes: master data (item to category mapping, categories), approvals, kernel.
- Must not: know about inventory tables, projects or ledgers; it works on opaque `(storeId, itemId)` keys and returns numbers. Inventory calls it; valuation never calls inventory.
- Out of scope: quantities on hand (inventory owns them; valuation keeps only the quantity it needs to value, validated against inventory by the caller), LIFO (excluded: not allowed under IFRS, confirm with accountant), standard cost and landed cost (BACKLOG), client-owned stock (never valued).

## 3. Data model
- `val_policies(id, scope company|category, category_id nullable, method weighted_average|fifo, effective_from date, status pending_approval|active|superseded|rejected, requested_by, approved_by, created_at)`; unique active policy per scope key and effective date; exactly one active company policy at any time.
- `val_wa_state(store_id, item_id, quantity numeric(18,4), total_value numeric(18,2), updated_seq bigint)` current state for weighted-average keys.
- `val_layers(id, store_id, item_id, receipt_ref, received_seq bigint, remaining_qty numeric(18,4), unit_cost numeric(18,4), original_qty, created_at)` for FIFO keys.
- `val_movements(id, seq bigserial, store_id, item_id, type receipt|issue|transfer_out|transfer_in|return|transition, quantity, value numeric(18,2), unit_cost numeric(18,4), method_used, source_ref, idempotency_key unique, created_at)` append-only.
- `val_transitions(id, store_id, item_id, from_method, to_method, qty, value_before, value_after, policy_id, completed_at)`.

## 4. Business rules
- BR-1 **Policy resolution:** for an item on a given posting date the method is the active category policy for the item's category (nearest ancestor with a policy, walking up the category tree) with `effective_from <= date`, else the active company policy. There is always a company policy; the initial one comes from H-07 (default weighted average).
- BR-2 **Policy changes** are effective-dated, may not be back-dated (effective_from must be >= today), and take effect only for movements posted on or after that date; past movements keep their valuation.
- BR-3 **Approval:** creating or changing a policy goes through the approval engine (doc type `valuation_policy`); it becomes `active` only after approval and on its effective date.
- BR-4 **Weighted average (moving):** on receipt of quantity q at unit cost c: `total_value += round(q x c, 2)`, `quantity += q`, `avg = total_value / quantity` (4 decimals for display only; the stored state is quantity and total value). On issue of quantity q: if `q == quantity` the issue value is the entire `total_value` (clears rounding residue); otherwise value = `round(q x total_value / quantity, 2)`; then `quantity -= q`, `total_value -= value`.
- BR-5 **FIFO:** a receipt creates a layer (remaining = q, unit cost c, value `round(q x c, 2)`). An issue consumes layers oldest first by `received_seq`; consumption from a layer = `round(taken x layer.unit_cost, 2)`, except that a layer fully consumed uses its remaining value (value tracked as `remaining_qty x unit_cost` rounded once at layer creation and reduced by amounts consumed, so layer values never drift). Issue value = sum of parts; the result lists each part (layer ref, quantity, unit cost, value).
- BR-6 **Conservation:** for every key, `total value after = total value before + receipts - issues` exactly (to the paisa), under both methods and across transitions; a violation is a defect (asserted in code paths and tests).
- BR-7 **Issues beyond known quantity** (valuation quantity less than the issue) are refused with an error; valuation never invents value.
- BR-8 **Transfer:** `recordTransfer(from, to, item, qty)` values the quantity as an issue at the source (using the source's method), then records a receipt at the destination at that same total value (unit cost = value / qty, 4 decimals, with the destination state taking the exact total value so conservation holds); if source and destination use different methods (not possible within the same item category and date, but possible after a mid-day policy start) the source's method values it.
- BR-9 **Returns:** `recordReturn(issueRef, qty)` restores quantity at the original issue unit cost for the returned quantity: for weighted average it adds back `round(qty x original unit cost, 2)`; for FIFO it recreates a layer at the original unit cost positioned with a `received_seq` equal to the original layer's sequence (restoring FIFO order for returned stock).
- BR-10 **Transition** (method change for a key with stock on hand): at the effective date the engine converts state without changing total value: weighted average to FIFO creates one layer per key with remaining quantity = on-hand quantity and unit cost = `total_value / quantity` (value held exactly), `received_seq` = transition sequence; FIFO to weighted average sets `quantity = sum(remaining)`, `total_value = sum(layer values)` and closes the layers. `value_before` must equal `value_after` or the transition is aborted entirely (single transaction) and reported.
- BR-11 Transitions run once per key per policy change, triggered lazily at the first movement on or after the effective date or by an explicit admin "run transition" action; running twice is a no-op (idempotent via `val_transitions`).
- BR-12 Every valuation call is idempotent on `idempotency_key`; repeats return the original result.
- BR-13 Reports: stock valuation report by store, item, category with the method used and the total; reconciliation to the inventory quantity is done in the integrity report of P1-12 plus the valuation query `getTotalValue`.
- BR-14 `val_movements` and layer consumption are append-only; no update or delete path exists.

## 5. API and UI
- `GET /valuation/policies`; `POST /valuation/policies` (request change); policy approval through approvals; `POST /valuation/transitions/run`
- `GET /valuation/stock-value?store&item&category`; `GET /valuation/movements`
- Screens: valuation settings (company default, category overrides, upcoming changes), policy change request, valuation report, transition log. Service-level functions are called by inventory, not through public routes.

## 6. Permissions
`valuation.policy.read` (accountant, management, storekeeper read), `valuation.policy.request` (accountant), approval by roles in the approval rules (owner or management), `valuation.transition.run` (accountant, admin), `valuation.report.read` (accountant, management).

## 7. Test requirements
- T-1 Worked examples (the cement example: 100 at 1,200 then 100 at 1,300, issue 50): FIFO issue = 60,000; weighted average issue = 62,500; remaining values 190,000 and 187,500 respectively; unit tests for each and for partial and full consumption across layers.
- T-2 Weighted-average residue rule: sequences that would leave residue clear exactly on the final issue; total of issues plus remaining value equals total of receipts.
- T-3 FIFO multi-layer issue breakdown, exact layer values, layers fully consumed use remaining value (no drift).
- T-4 Property tests (fast-check, 1,000+ runs each): for random sequences of receipts, issues, returns and transfers under each method, conservation holds exactly; no layer or state goes negative; issue value never exceeds total value; value and quantity are both zero together.
- T-5 Transition tests: WA to FIFO and FIFO to WA preserve total value exactly for random states; second run is a no-op; failure aborts atomically (inject a mismatch).
- T-6 Policy resolution: category override beats company default; nearest ancestor wins; effective dates; no back-dating; only one active company policy; unapproved policy is inactive.
- T-7 Issue beyond quantity refused; idempotent repeat returns the same result.
- T-8 Returns restore original unit cost and FIFO order.
- T-9 Mixed methods across categories in one scenario give per-category values that sum to the total.
- T-10 Route contract tests, repository integration tests (including concurrency on the same key), component tests for the settings screen; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 Switching the company default from weighted average to FIFO (approved, effective tomorrow) leaves total stock value unchanged at the switch and values later issues by FIFO.
- AC-2 A category override changes the method for that category only.
- AC-3 Conservation holds to the paisa in all property tests.
- AC-4 No past issue's recorded value changes after a policy change.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-07: initial policy. Default allowed: company default weighted average, no overrides, recorded in the PR.
