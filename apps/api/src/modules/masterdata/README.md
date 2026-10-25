# masterdata

Shared reference data (spec P1-05): company profile, tax registrations, parties, units and
conversions, item categories and items, cost codes, locations and vendor price lists. Tables are
`mst_*`. The module holds no transactional data.

Other modules call, at startup:

```ts
masterData.registerReferenceCheck('party', (db, partyId) => hasDocumentsFor(db, partyId)); // BR-8
masterData.registerReferenceCheck('item', (db, itemId) => hasDocumentsFor(db, itemId));
masterData.registerCostCodeUsage((db, costCodeId) => ledger.usageOf(db, costCodeId)); // BR-6 (P1-09)
```

Choices where the spec leaves room (none changes a rule):

- Party codes come from the number series `party_client`, `party_vendor`, `party_subcontractor` and
  `party_labour_contractor` (`CL-0001`, `VN-0001`, ...), using the series of the first listed role.
- Repeating an NTN or CNIC is always refused; repeating name plus phone is a warning that the caller
  confirms with `confirmDuplicate: true`. An inactive party does not take part in the NTN and CNIC
  check.
- `getRegistration(authority)` returns the registration in force today; when several types are in
  force it prefers `ntn`, then `strn`, `pra`, `other`, unless a `type` is given.
- A cost code is deactivated unless it has posted costs and open budget lines (BR-6); until the
  cost ledger registers its check nothing counts as posted.
- Units are seeded from the H-26 default list; no conversion factors are seeded.
- The top-level cost codes 100 to 600 are seeded from H-25; sub-codes are added from the UI.
- Permissions beyond the spec's list: `master.reference.read` (company, registrations, units,
  cost codes, locations), `master.item.read` and `master.price.read`.
