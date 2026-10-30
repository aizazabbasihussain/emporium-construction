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
- [P1-15] BR-8: show manpower from attendance counts when attendance exists for the project and date. The spec makes it conditional on the attendance query interface (P1-17), which does not exist yet; the manual manpower field is the only source until P1-17 adds `getHeadcount(projectId, date)` and the report view merges it
- [P1-15] Material notes keep `unit_code` as free text (max 20 characters) because the spec's consumes list does not include master data; check it against the units list once a unit lookup is agreed. Also a visible "late" marker on reports submitted after the day they cover, and a reminder to the supervisor (today only project managers are told at 18:00)
- [P1-11] Purchase returns to the vendor (out of scope in the spec). A challan photo uploaded as its own step before a receipt is posted (today the photo travels inside the receipt request)
- [P1-16] BR-6: the attendance check before a worker is marked as left (`attendance.listUnapprovedSheets`) is an interface that P1-17 implements; until then the composition root passes a stub that reports no sheets, so a worker can be deactivated even with unapproved attendance. P1-17 must replace the stub in `apps/api/src/compose.ts`
- [P1-16] H-11 (working-days basis) is open with no default: `workforce.working_days_basis` is 0 until the owner decides, and `getWorkerRate` refuses the daily equivalent of a monthly salary until it is set. Also: the labour contractor party is accepted on the API but not shown in the worker form, and trades are managed only through the API (no screen)
- [P1-17] BR-7: the check that stops an unlock once the month's wage period is approved goes through `wages.approvedPeriodOf(db, date)`, an interface P1-18 must implement; until then `apps/api/src/compose.ts` passes a stub that reports no approved period. P1-18 must replace the stub
- [P1-17] P1-15 BR-8 can now show manpower from attendance: `attendance.getAttendanceHeadcount(db, projectId, date)` counts workers present or on a half day on submitted and approved sheets. The daily report module still uses only its manual field and needs a change to read it
- [P1-17] Overtime can only be recorded on a present or half day (a worker who works on an `off` day is entered as present). Missing-sheet detection treats Monday to Friday as working days, as the spec says weekdays; a Saturday-working crew needs a setting for the working week. The grid has no explicit cost-code picker (the API accepts one per allocation) and no printout of the paper attendance sheet (H-14 sample still open)
- [P1-17] H-11 defaults used, all editable settings: `workforce.working_days_basis` 26, `attendance.overtime_multiplier` 1.5. The third part of H-11 (net pay rounded to PKR 1) belongs to P1-18
