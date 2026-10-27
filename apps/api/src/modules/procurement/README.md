# procurement

Requisitions, quote comparison, purchase orders and goods receipts (spec P1-11). Approved orders
commit cost to the project; receipts turn the commitment into approved cost and tell inventory what
arrived. Public entry point: `index.ts`. Business rules live in `packages/domain/src/procurement`.
