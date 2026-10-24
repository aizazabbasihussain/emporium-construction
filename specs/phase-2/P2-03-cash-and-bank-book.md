---
id: P2-03
title: Cash and bank book
phase: 2
module: cashbook
status: not-started
depends_on: [P1-05, P1-14]
requires_inputs: [H-05, H-13]
---

# P2-03 Cash and bank book

## 1. Purpose
Record every movement of cash and bank money in one place (receipts, payments, transfers, bank charges), with running balances and bank reconciliation, so the owner and accountant always know the cash position.

## 2. Boundary
- Owns: tables `cbk_*`, module `cashbook`.
- Provides: `recordReceipt(cmd)`, `recordPayment(cmd)`, `recordTransfer(cmd)`, `getAccountBalance(accountId, date)`, `getCashPosition(date)`, events `cash.receipt.recorded`, `cash.payment.recorded`; view `cbk_v_transactions`.
- Consumes: expenses (`advance.issued`, `expense.posted`) to record custodian cash outflows, kernel, files, approvals (large payments), chart-of-accounts tags (P0-03 accounts).
- Must not: allocate receipts to invoices or payments to bills (receivables and payables do that and call this module for the money movement).
- Out of scope: general ledger and journals, bank feeds (BACKLOG), foreign currency, cheque lifecycle (PDC register belongs to P2-04; issued cheques to P2-05, both call this module).

## 3. Data model
- `cbk_accounts(id, code, name, kind cash|bank|petty_cash|wallet, bank_name, account_number_masked, account_code_tag text nullable, opening_balance numeric(18,2), opening_date, active, ...base)`.
- `cbk_transactions(id, number, account_id, txn_date, direction in|out, amount numeric(18,2), txn_type receipt|payment|transfer_in|transfer_out|bank_charge|advance|other, counterparty_party_id nullable, source_module, source_doc_type, source_doc_id, method cash|cheque|bank_transfer|online|wallet, reference text, description, account_tag text nullable, reconciled_in nullable, reverses_id nullable, idempotency_key unique, posted_at)` append-only.
- `cbk_reconciliations(id, account_id, statement_from, statement_to, statement_closing_balance, book_balance_at_end, difference, status draft|completed, completed_by)`; `cbk_reconciliation_items(reconciliation_id, transaction_id, matched_statement_ref)`; `cbk_statement_lines(id, reconciliation_id, line_date, description, debit, credit, matched_transaction_id nullable)`.

## 4. Business rules
- BR-1 Balance = opening balance + sum(in) - sum(out) for transactions on or before the date; opening balances are set once from the migration data (H-13) and then immutable (changes need a dated adjustment transaction approved by management).
- BR-2 Transactions are append-only; corrections are reversing transactions linked via `reverses_id`; a reversal needs a reason and `cashbook.txn.reverse`.
- BR-3 An `out` transaction from a `cash` or `petty_cash` account cannot take its balance below zero (error shows the shortfall); bank accounts may overdraw only if the account flag `allow_overdraft` is true.
- BR-4 Transfers between accounts create two linked transactions atomically (out and in, same amount, same date).
- BR-5 Payments above the approval band (doc type `payment`, H-09) need an approved payment request before `recordPayment` (the caller passes the approval id); the user who creates a payment cannot approve it.
- BR-6 `advance.issued` creates an `out` transaction from the chosen cash account to the custodian; `expense.posted` records no cash movement (the advance already did) unless the claim was reimbursed from cash, which the accountant records as a separate payment.
- BR-7 Account tags: each transaction may carry an account code tag from the chart of accounts (P0-03) set by posting rules in the calling module or by the accountant; untagged transactions are listed in a "needs tag" report.
- BR-8 Bank reconciliation: statement lines are imported from CSV (date, description, debit, credit); lines are matched to transactions by amount and date proximity (suggested), and confirmed by the accountant; completing requires `statement closing balance = book balance - unreconciled book items + unreconciled statement items` within zero difference, else it stays draft with the difference shown; reconciled transactions are flagged and cannot be reversed without un-reconciling.
- BR-9 Daily cash position report: balances per account, total cash, total bank, and movement of the day.
- BR-10 Business dates follow the kernel rules (not future, backdating allowance).

## 5. API and UI
- CRUD `/cashbook/accounts`; `POST /cashbook/receipts|payments|transfers`; `POST /cashbook/transactions/:id/reverse`; `GET /cashbook/transactions`; `GET /cashbook/position?date=`; reconciliation: `POST /cashbook/reconciliations`, `POST /cashbook/reconciliations/:id/import`, `.../match`, `.../complete`.
- Screens: accounts, cash book (running balance), new receipt and payment, transfer, reconciliation workspace, daily position, needs-tag list.

## 6. Permissions
`cashbook.account.manage` (accountant, management), `cashbook.txn.read` (accountant, management), `cashbook.txn.create` (accountant), `cashbook.txn.reverse` (accountant with reason), `cashbook.reconcile` (accountant).

## 7. Test requirements
- T-1 Balance arithmetic on dates; opening balance immutability.
- T-2 Overdraw rules by account kind and flag.
- T-3 Transfer atomicity (failure of the second leg rolls back the first).
- T-4 Reversal rules and linkage; reconciled transactions block reversal.
- T-5 Approval requirement and separation of duties on payments.
- T-6 Event handlers for advances and posted expenses are idempotent.
- T-7 Reconciliation: matching suggestions, completion difference rule with worked examples including unreconciled items on both sides.
- T-8 Property test: after random valid operations, balance equals opening + sum of signed transactions and transfers net to zero across accounts.
- T-9 Route contract tests, repository integration tests, component tests; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 Receipts, payments and a transfer produce correct running balances; reversals leave a visible trail.
- AC-2 A bank reconciliation with a statement import completes only at zero difference.
- AC-3 Cash cannot go negative.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-05 (chart of accounts for tags; untagged allowed until answered), H-13 (opening balances; needed before real go-live, not for building).
