# payables

Vendor bills, three-way match and payments (spec P2-05). What the company owes each vendor, the cost a
bill confirms, and the payments that settle it.

- **Money moves only through the cash book** (BR-7): `pay` records one cash book payment per payment
  (cheque number and date are kept). A post-dated cheque is marked paid but reaches the cash book on its
  cheque date through `postDueCheques`, which the scheduler tick runs.
- **Match** (BR-1): each bill line is compared with its order line and receipt line. Billed quantity above
  what was received and not yet billed (every live bill counts, drafts included) and a rate different from
  the order rate are variances; beyond the tolerances of `payables.match_qty_tolerance_percent` and
  `payables.match_rate_tolerance_percent` (H-23, default 0) the bill is `matched` only with a reason from
  a user holding `payables.bill.override_match`.
- **Tax and withholding** (BR-3, BR-4): worked out by the tax engine when the bill is submitted (place of
  supply from the bill's location or its project's); a bill without rules is refused. The owner approves
  (H-09); the engine keeps the user who entered a bill from approving it.
- **Posting** (BR-5): the receipt cost of each line moves from `approved` to `posted` (once per receipt
  line even when several bills split it); lines of other sources are posted, or confirm the entry the
  source approved. A price difference becomes a `posted` variance entry: to the line's cost object when
  the goods went straight to site or were issued, otherwise to overhead under the cost code of
  `payables.price_variance_cost_code` (H-22). Stock valuation is never changed.
- **Cancelling** (BR-10): a posted bill with no live payment and no later bill on the same receipt line
  reverses its cost and variances and gives the receipt cost back as `approved`.
- **Payments** (BR-7): allocations are in gross terms for one vendor's posted bills; the cash paid is the
  allocations less the withholding deducted. Drafts reserve what they allocate, including the withholding.
  Above `cashbook.payment_approval_threshold` the owner approves; the approver cannot pay it.
  Allocations are immutable (a trigger enforces it); a cancelled payment stops counting through its status.
- **Payment runs** (BR-11): one approval for the payments of the selected bills grouped by vendor.
- **Reports** (BR-8, BR-9): vendor balance and ledger (`pay_v_vendor_ledger`), aging in the receivables
  buckets, and the withholding report per authority and month with the certificate number.
- **Other sources** (BR-6): `registerBillSource` takes a provider (P2-06 registers subcontract
  certificates); the provider builds the bill and is told when it is posted or cancelled.

Not here: purchase returns and debit notes, vendor prepayments beyond an advance bill, retention. The
spec's permission `payables.bill.override-match` is `payables.bill.override_match` (see CHANGES.md).
