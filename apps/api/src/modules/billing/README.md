# billing

Stage billing, advances and credit notes (spec P2-02). A project's billing schedule comes from its
accepted quotation and grows by one stage for each approved variation. An invoice bills one or more
planned stages; the tax engine (P2-01) rates it, the owner approves it, and it is numbered only when it
is issued.

```
draft -> pending_approval -> approved -> issued
  \_______________\_____________\-> cancelled   (never an issued invoice: that takes a credit note)
```

- **Advance recovery** (H-28): proportional to the invoice's share of the unbilled contract value by
  default, or a fixed percent of each base; set with `billing.advance_recovery_method` and
  `billing.advance_fixed_percent`. `billing.tax_on_advance_at_receipt` decides whether the recovery is
  a deduction line (true) or reduces the taxable base (false).
- **Issue** locks the invoice, takes the number from the series of the authority (`invoice_<authority>`
  when it exists, else `invoice`), marks the stages invoiced, applies the recovery to the received
  advances and emits `invoice.issued` once. The figures must be the ones the owner approved.
- **Credit notes** reverse tax with the rates stored on the invoice and give the recovery back to the
  advance. A credit note for everything left cancels the invoice and releases its stages.
- **Invoice sources** are pluggable: `registerInvoiceSource(type, provider)`; `project_stage` is the
  only provider here.

Not here: payments (P2-04), cash, the cost ledger, retention, e-invoicing.
