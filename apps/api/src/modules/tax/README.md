# tax

Tax engine (spec P2-01): sales tax and withholding tax from effective-dated rules by authority,
location and nature of supply. No rate or rule is in code or in the seeds; everything is data that
the accountant requests and the owner approves.

Billing (P2-02) and payables (P2-05) call the module inside their own transaction and store the
returned snapshot on the document, so a later rule change never alters an issued document.

```ts
const snapshot = await tax.calculateSalesTax(tx, {
  locationId,
  supplyKind: 'services',
  date: '2026-11-17',
  lines: [{ id: 'line-1', amount: '100000.00', nature: 'civil' }],
});
// snapshot.base, snapshot.taxTotal, snapshot.total, snapshot.taxLines, snapshot.rules ...
const withheld = await tax.calculateWithholding(tx, {
  direction: 'we_withhold',
  authorityCode: snapshot.authorityCode,
  nature: 'civil',
  date: '2026-11-17',
  invoiceTotal: snapshot.total,
  taxAmount: snapshot.taxTotal,
  base: snapshot.base,
});
```

A missing mapping, registration or rule is an error that names what is missing; a document is never
silently untaxed. Owning modules register the views that expose their stored snapshots with
`registerReportSource`, which feeds `taxReportData`.
