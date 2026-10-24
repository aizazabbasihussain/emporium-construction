---
id: P2-05
title: Payables, vendor bills and payments
phase: 2
module: payables
status: not-started
depends_on: [P2-01, P2-03, P1-11, P1-12, P1-09]
requires_inputs: [H-03, H-22, H-23, H-09]
---

# P2-05 Payables, vendor bills and payments

## 1. Purpose
Record vendor bills, match them to purchase orders and goods received, handle tax and withholding, approve and pay them, and confirm project cost as `posted` when a bill is accepted.

## 2. Boundary
- Owns: tables `pay_*`, module `payables`, bill source registry.
- Provides: `getVendorBalance(partyId, date)`, `getOpenBills(partyId)`, `getPaidAmount(source)`, `registerBillSource(type, provider)` (used by P2-06), `isGrnBilled(grnId)` (used by procurement to block GRN cancellation), events `bill.posted`, `payment.recorded`; view `pay_v_vendor_ledger`.
- Consumes: procurement (POs, GRNs), inventory (receipt cost lines through GRN data), projects (`transitionCost`, `postCost`), tax engine (input tax, withholding we deduct), cash book (`recordPayment`), approvals, files.
- Must not: write stock or POs; money movement always through the cash book.
- Out of scope: purchase returns and debit notes to vendors (BACKLOG), prepayment to vendors beyond a simple advance bill, retention.

## 3. Data model
- `pay_bills(id, number, vendor_party_id, vendor_invoice_no, bill_date, due_date, source_type purchase|subcontract|expense_other, status draft|matched|pending_approval|approved|posted|partly_paid|paid|cancelled, base_amount, tax_total, gross_total, withholding_total, net_payable numeric(18,2), tax_snapshot jsonb, authority_code, notes, ...base)` unique `(vendor_party_id, vendor_invoice_no)`.
- `pay_bill_lines(id, bill_id, source_doc_type nullable, source_doc_id nullable, po_line_id nullable, grn_line_id nullable, description, quantity, rate numeric(18,4), amount numeric(18,2), cost_object_type, cost_object_id, cost_code_id)`.
- `pay_matches(bill_line_id, po_rate, grn_qty, billed_qty, billed_rate, qty_variance, rate_variance, within_tolerance bool)`.
- `pay_payments(id, number, vendor_party_id, payment_date, method cash|cheque|bank_transfer|online, amount numeric(18,2), withholding_deducted numeric(18,2), account_id, cheque_number, cheque_date nullable, status draft|pending_approval|approved|paid|cancelled, approval_request_id, cashbook_txn_id nullable, ...base)`; `pay_payment_allocations(payment_id, bill_id, amount)`.
- `pay_variances(id, bill_line_id, cost_object_type, cost_object_id, amount, treatment project_cost|overhead_cost, ledger_entry_id)`.

## 4. Business rules
- BR-1 **Three-way match** per bill line against the PO line and GRN line: billed quantity must not exceed received (accepted) quantity less quantity already billed; billed rate is compared with the PO rate; quantity and rate variances beyond tolerance (H-23, default zero) put the bill in `matched` only after a user with `payables.bill.override-match` confirms with a reason.
- BR-2 Duplicate protection: vendor plus vendor invoice number is unique; amounts above the vendor's open commitments trigger a warning.
- BR-3 Input tax and withholding we deduct are calculated by the tax engine on the bill (authority from the project location; supply kind from the lines); a bill without resolvable rules cannot be approved (same refusal rule as billing).
- BR-4 Net payable = gross total - withholding deducted; approval through the engine (doc type `vendor_bill`, amount = gross total); separation of duties: the user who entered the bill cannot approve it.
- BR-5 **Posting a bill** (accountant action after approval): for each line, the matching cost entry in the cost ledger moves from `approved` to `posted` (project-destined lines), or for store-destined lines the received stock keeps its valuation cost and the bill records only liability; price differences between billed and receipt/PO rate are handled per H-22 (default: if the goods were already issued or were direct-to-site, the variance is posted to the cost object of the line as a `posted` entry (positive or negative); if the goods are still in stock, the variance is posted to the overhead cost object under cost code from setting `price_variance_cost_code`); stock valuation is never retroactively changed. Posting emits `bill.posted` once.
- BR-6 Bills from other sources (subcontract certificates) enter through registered providers and follow the same approval, tax, posting and payment steps.
- BR-7 **Payments:** allocated across one or more bills of one vendor; allocation sum = payment amount + withholding deducted; payments over the approval band go through the engine (doc type `payment`); only approved payments can be `paid`; paying records a cash book payment (cheque issues are recorded with cheque number and date; a post-dated issued cheque posts to the cash book on its cheque date through a daily job, not before) and updates bills to `partly_paid` or `paid`.
- BR-8 Withholding deducted is recorded per authority and month for the accountant's withholding report; a withholding certificate number can be recorded when issued.
- BR-9 Vendor balance = posted bills' net payable + withholding payable (shown separately) - payments allocated; aging uses due dates (same buckets as receivables setting).
- BR-10 Cancelling a posted bill requires the accountant, a reason and no payments allocated; it reverses the cost transitions and variance entries.
- BR-11 Payment runs: a batch of selected approved bills creates payments grouped by vendor for one approval.
- BR-12 Opening vendor balances come from the importer (opening bills with no GRN, source `opening`, no cost posting).

## 5. API and UI
- CRUD `/payables/bills`; `POST /payables/bills/:id/match|submit|post|cancel`; `/payables/payments` (+ `/submit`, `/pay`, `/cancel`); `POST /payables/payment-runs`; `GET /payables/vendors/:id/ledger`; `GET /payables/aging`; `GET /payables/withholding-report`.
- Screens: bill entry with PO/GRN pick list and match panel, bills queue by status, payment builder, payment runs, vendor ledger, aging, withholding report.

## 6. Permissions
`payables.bill.create|read|post` (accountant, procurement create and read), `payables.bill.override-match` (accountant), `payables.payment.create|pay` (accountant), approval by roles in the approval rules (management), `payables.ledger.read` (accountant, management).

## 7. Test requirements
- T-1 Match calculations with worked examples (billed above PO rate, partial billing across several bills, over-billing beyond received).
- T-2 Tax and withholding totals on bills using synthetic rules; net payable.
- T-3 Posting: cost entry transitions approved to posted; variance treatment both ways (issued goods vs in-stock goods); stock valuation untouched (assert valuation movements unchanged).
- T-4 Duplicate guard; separation of duties; state machine exhaustive.
- T-5 Payment allocation validation; partial payment status; cheque post-dating job with a fixed clock; cash book calls once.
- T-6 Cancellation rules and exact reversals.
- T-7 Property tests: vendor balance equals bills minus payments for random sequences; cost ledger totals equal sum of posted lines plus variances.
- T-8 Provider registry with a fake subcontract provider.
- T-9 Route contract tests, repository integration tests, component tests; Playwright: PO to GRN to bill to payment; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A bill matched to a PO and GRN is approved, posted (project cost becomes `posted`) and paid by cheque with correct balances.
- AC-2 A price variance is posted per the configured treatment and never changes stock valuation.
- AC-3 A bill cannot be approved by its creator.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-03 (withholding rules: stop if unanswered), H-09 (approval limits: stop), H-22 and H-23 (defaults allowed).
