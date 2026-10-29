# BACKLOG

Ideas and deferred items. The agent adds entries here instead of building them. Format: `- [source spec] idea (why deferred)`.

- [constitution] Optional full general ledger, trial balance and statements if the accountant later wants the app as the book of record (not needed in year one)
- [P2-04] Retention on client bills (not needed now; may be needed for government work)
- [P2-07] EOBI and social-security deductions in payroll
- [P2-09] Bank-feed automation and a native accounting-software integration adapter
- [P1-13] Additional costing methods (standard cost) behind the same valuation strategy interface
- [P1-12] Landed-cost allocation (freight, loading) into receipt cost
- [P3-04] Recurring service contracts (AMC) and preventive maintenance
- [P1-09] Admin manual journal for overhead cost entries with approval (named in section 5 but with no route, permission, approval document type or test in the spec; postCost already accepts overhead from other modules)
- [P1-11] Wire the receipt guards of procurement (`GrnGuards`: stock issued from a receipt, bill that refers to it) to inventory (P1-12) and payables (P2-05); until then they report nothing issued or billed. Procurement keeps the store of an order as an opaque id until P1-12 owns stores
- [P1-14] A claim approved after its project stopped being open (not planning or active) cannot book its cost: the approval event fails and stays in the outbox failure list until the project is reopened. A visible "approved but not booked" state on the claim would make this easier to see (decided: add this state)
- [P1-14] Reversing a posted claim, or cancelling an approved one, emits only `expenses.claim.changed`; the cash book (P2-03) may want a dedicated event. Also an API for the accountant to cancel or settle an advance that was issued by mistake (the `cancelled` advance status exists but nothing sets it)
- [P1-14] Warn (do not block) when a claim would take a custodian past `float_limit`; today the limit is shown but not checked. Cancelled and reversed claims share the `cancelled` status and advances auto-settle at a zero balance: both accepted as is
- [P1-11] Purchase returns to the vendor (out of scope in the spec). A challan photo uploaded as its own step before a receipt is posted (today the photo travels inside the receipt request)
