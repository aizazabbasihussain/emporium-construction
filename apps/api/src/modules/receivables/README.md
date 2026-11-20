# receivables

Receivables, receipts and the post-dated cheque register (spec P2-04). What each client owes, the receipts
that pay it down, the tax the client withheld, and the cheques in hand.

- **Money moves only through the cash book** (BR-2): cash, bank transfer and online receipts post a cash
  book receipt at once (status `cleared`); a cheque or PDC waits as `pending_clearing` with no movement
  until it is cleared. A bounce or cancellation of cleared money posts a reversing cash book entry.
- **Balance** (BR-1): issued invoices (the billing view `bil_v_invoices`) less credit notes, cleared
  allocations, withholding and approved write-offs. Unallocated receipts and unapplied advances are shown
  as customer credit next to the balance, never netted silently.
- **Allocation** (BR-3): the allocations of a receipt equal receipt plus withheld amount, withholding lines
  equal the withheld amount, and an invoice never takes more than it owes less cheques still in hand.
  Allocations are immutable (a trigger enforces it); a receipt that bounces or is cancelled stops counting
  through its own status. A receipt is allocated once, at recording or later by `POST .../allocate`.
- **Withholding** (BR-4): compared with `withholding_expected`; a difference above
  `receivables.withholding_tolerance` is flagged in the receipt answer, never blocked.
- **Advances** (BR-5): billing is told through `markAdvanceReceived` when the money of an advance arrives
  (at once for cash, at clearing for a cheque). Billing cannot take it back, so a cleared advance receipt
  cannot be cancelled or bounced.
- **Cheques** (BR-6): received, deposited (account chosen; before the cheque date only with a reason),
  cleared or bounced; returned and replaced end the cheque. A cleared cheque may still bounce (AC-2): the
  cash is reversed, the invoices reopen, a follow-up is opened and the accountants are told.
- **Reminder** (BR-7): `remindUpcomingPdcs` runs from the scheduler tick, once a business day from 09:00
  Asia/Karachi.
- **Aging** (BR-8): buckets from `receivables.aging_buckets` (H-30 default `30,60,90`), per customer or
  project, as of any date, from allocations that had cleared and not been cancelled on that date.
- **Write-offs** (BR-11): at most `receivables.small_balance_limit` (default 0: none until set), approved by
  the owner (`write_off`), and the approver cannot record it.

Known limits: credit notes count in full in balances and aging from the day the view shows them (the view
has no issue date; statements use the real dates). Not here: retention release, dunning letters,
write-offs beyond an approved adjustment.
