# valuation

Stock valuation engine (spec P1-13): decides what cost is attached to stock when it is received and
issued. The method is weighted average or FIFO, set for the company with optional per-category
overrides, effective-dated and approved by the owner.

Inventory (P1-12) calls the module inside its own transaction; valuation never calls inventory and
knows nothing of stores or items beyond the opaque `(storeId, itemId)` key.

```ts
await valuation.recordReceipt(
  { storeId, itemId, quantity: '100', unitCost: '1200', postingDate, idempotencyKey },
  actor,
  tx,
);
const issue = await valuation.valueIssue(
  { storeId, itemId, quantity: '50', postingDate, idempotencyKey },
  actor,
  tx,
);
// issue.value is the cost of the issue; issue.parts lists the layers (FIFO) it came from.
await valuation.recordReturn(
  { issueRef: issue.movementId, quantity: '10', postingDate, idempotencyKey },
  actor,
  tx,
);
await valuation.recordTransfer(
  { fromStoreId, toStoreId, itemId, quantity: '5', postingDate, idempotencyKey },
  actor,
  tx,
);
```

Every call is idempotent on `idempotencyKey`; a repeat returns the original result. Transfers use
`<key>:out` and `<key>:in` for their two movements.

## How it fits together

- The method for a movement is resolved from the item's category chain and the posting date
  (BR-1). A key (store and item) is converted lazily at its first movement under a new policy, or
  by the admin action `POST /valuation/transitions/run`. A key never goes back to an earlier
  policy: its method is resolved at the later of the posting date and its last posting date.
- `val_keys` holds the current method of a key and is the lock row for every movement on it.
- Weighted-average state lives in `val_wa_state`; FIFO layers in `val_layers` (with
  `remaining_value`, so layer values never drift). Movements, consumptions and return parts are
  append-only (database triggers).
- Policy changes use the approval document type `valuation_policy`. The module listens to
  `approval.approved|rejected|returned|cancelled` and activates or rejects the policy; an approval
  that arrives after the requested start date starts the policy on the day of approval.

## Human inputs

H-07 (initial policy) was `open` with a default allowed: company default weighted average from
2000-01-01, no category overrides. It is seeded in migration `0008_valuation.sql`.
