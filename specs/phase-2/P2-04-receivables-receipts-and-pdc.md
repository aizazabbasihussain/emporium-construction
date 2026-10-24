---
id: P2-04
title: Receivables, receipts and PDC register
phase: 2
module: receivables
status: not-started
depends_on: [P2-02, P2-03, P2-01]
requires_inputs: [H-03, H-30]
---

# P2-04 Receivables, receipts and PDC register

## 1. Purpose
Track what each client owes, record receipts (cash, cheque, bank transfer, post-dated cheques), allocate them to invoices, record tax withheld by clients, and chase overdue balances.

## 2. Boundary
- Owns: tables `rcv_*`, module `receivables`.
- Provides: `getCustomerBalance(partyId, date)`, `getOpenInvoices(partyId)`, `getCollectedAmount(projectId)`, events `receipt.recorded`, `pdc.cleared`, `pdc.bounced`; view `rcv_v_customer_ledger`.
- Consumes: billing (issued invoices, credit notes, advances), cash and bank book (`recordReceipt`), tax engine (client withholding), files, notifications.
- Must not: write invoices or edit tax; money movement is always performed through the cash book.
- Out of scope: retention release (BACKLOG), write-offs beyond an approved adjustment, dunning letters.

## 3. Data model
- `rcv_receipts(id, number, party_id, receipt_date, method cash|cheque|bank_transfer|online|pdc, amount numeric(18,2), account_id, reference, status recorded|pending_clearing|cleared|bounced|cancelled, withheld_amount numeric(18,2) default 0, withholding_certificate_ref, cashbook_txn_id nullable, ...base)`.
- `rcv_allocations(id, receipt_id, invoice_id nullable, advance_id nullable, amount numeric(18,2), kind invoice|advance|withholding)`.
- `rcv_pdcs(id, receipt_id, cheque_number, bank_name, drawer, cheque_date, amount, status received|deposited|cleared|bounced|returned|replaced, deposited_on, cleared_on, bounced_on, bounce_reason, replaced_by_pdc_id)`.
- `rcv_adjustments(id, party_id, invoice_id, amount, reason, approved_by)` (small-balance write-off with approval).
- `rcv_followups(id, party_id, invoice_id nullable, due_date, note, status open|done, assigned_to)`.

## 4. Business rules
- BR-1 Customer balance = issued invoices gross - credit notes - allocated receipts - allocated withholding - approved adjustments; unallocated receipts and unapplied advances are shown as customer credit, not netted silently.
- BR-2 Recording a receipt: cash, bank transfer and online receipts post the money movement through the cash book immediately (status `cleared`); cheques deposited post only when cleared; a PDC is recorded as `pending_clearing` with no cash book movement until it is marked cleared.
- BR-3 Allocation: the sum of allocations (invoice + advance + withholding) must equal receipt amount + withheld amount; allocations to an invoice cannot exceed its outstanding amount; auto-allocation suggests oldest-due first; the user confirms.
- BR-4 Withholding by client: the receipt records the withheld amount and certificate reference; the withheld amount is allocated to the invoice as `withholding` and compared with `withholding_expected`; a difference above the setting tolerance is flagged for the accountant but not blocked.
- BR-5 Advance receipts (for advance invoices) mark the advance `received` through billing's interface and leave unapplied credit that billing consumes when recovering on later invoices.
- BR-6 PDC lifecycle: received to deposited (choose bank account) to cleared or bounced; bounced reverses the cash book movement and the allocations of that receipt, reopens the invoices, creates a follow-up, and notifies the accountant; returned (given back to client) or replaced (new PDC) are terminal with a link; a PDC cannot be deposited before its cheque date unless the accountant overrides with a reason.
- BR-7 A PDC register report lists cheques by status and cheque date, upcoming deposits in the next 7 days (a daily 09:00 reminder), and the total value in hand.
- BR-8 Aging (H-30 default buckets 0-30, 31-60, 61-90, 90+ days past due) per customer and per project, as of any date, computed from invoice due dates and allocations at that date.
- BR-9 Receipts and allocations are immutable; corrections are cancellations (`cancelled`, linked reversing cash book entries) with a reason; a receipt tied to a reconciled bank transaction cannot be cancelled until un-reconciled.
- BR-10 Customer statement for a period: opening balance, invoices, credit notes, receipts, withholding, closing balance; printable.
- BR-11 Small differences: a balance under the setting `small_balance_limit` may be written off with approval (doc type `write_off`).

## 5. API and UI
- `POST /receivables/receipts`; `POST /receivables/receipts/:id/allocate|cancel`; `GET /receivables/customers/:id/ledger|statement`; PDC: `GET /receivables/pdcs`, `POST /receivables/pdcs/:id/deposit|clear|bounce|return|replace`; `GET /receivables/aging`; follow-ups CRUD; `POST /receivables/adjustments`.
- Screens: receipt entry with allocation grid, PDC register, customer ledger and statement, aging report, follow-up list.

## 6. Permissions
`receivables.receipt.create|cancel` (accountant), `receivables.pdc.manage` (accountant), `receivables.ledger.read` (accountant, management), `receivables.adjustment.create` (accountant, approval by management).

## 7. Test requirements
- T-1 Balance arithmetic for scripted sequences (invoice, partial receipts, withholding, credit note, advance).
- T-2 Allocation validation (sums, over-allocation, withholding component); auto-allocation order.
- T-3 PDC state machine exhaustive; clearing posts to the cash book once; bounce reverses movement and allocations exactly; early deposit override.
- T-4 Aging buckets at boundary days and on past dates.
- T-5 Withholding tolerance flagging.
- T-6 Cancellation rules including reconciled transactions.
- T-7 Property tests: after random receipts and allocations, sum of customer balances equals total invoices - credit notes - allocated amounts; PDC bounce followed by re-receipt restores balances.
- T-8 Reminder job for upcoming PDC deposits with a fixed clock.
- T-9 Route contract tests, repository integration tests, component tests; Playwright: invoice to PDC to clearing; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 An invoice is paid by two receipts (one PDC cleared, one bank transfer) and the balance reaches zero.
- AC-2 A bounced PDC reopens the invoice and reverses the cash movement.
- AC-3 Aging report ties to the open invoice list.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-03 (client withholding rules: stop if unanswered when handling withholding amounts; receipts without withholding still work), H-30 (default buckets allowed).
