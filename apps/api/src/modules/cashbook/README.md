# cashbook

Cash and bank book (spec P2-03). One place for every movement of money: receipts, payments, transfers,
bank charges and advances, with a running balance per account, a daily cash position and bank
reconciliation.

- **Append-only** (BR-2): a transaction is never edited or deleted. A correction is a reversing
  transaction linked by `reverses_id`, with a reason. Only the reconciled flag and the account tag move
  after posting (a database trigger enforces it).
- **Balances** (BR-1): opening balance plus everything in less everything out on or before the date.
  The opening balance, its date and the account kind are immutable; a dated adjustment, approved by the
  owner, changes a balance.
- **No negative cash** (BR-3): cash and petty cash never go below zero on any day from the posting date
  on; a bank account or wallet may only when `allow_overdraft` is set. The error carries the shortfall.
- **Transfers** (BR-4) are two linked transactions in one database transaction.
- **Payments** (BR-5): above `cashbook.payment_approval_threshold` (default 0: all, H-09) the caller
  passes the id of an approved `payment` request. The approver cannot be the user who records it.
- **Advances** (BR-6): `advance.issued` becomes a pending movement; the account named in
  `cashbook.advance_account_id` takes it at once when it can, otherwise the accountant chooses.
- **Reconciliation** (BR-8): CSV import, suggestions by amount and date, confirmed matches, completion
  only at a zero difference.

Not here: allocating receipts to invoices or payments to bills (P2-04, P2-05), the general ledger, bank
feeds, foreign currency, the cheque lifecycle.
