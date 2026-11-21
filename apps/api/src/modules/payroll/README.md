# payroll

Payroll finalization, payment and payslips (spec P2-07). It turns the approved monthly wage sheet into
a run, confirms the labour cost on projects, pays the workers through the cash book and prints payslips.

- **Run** (BR-1): one run per approved wage period; its lines copy the net pay of the wage sheet. A worker
  with nothing to pay (the advance recovery took it all) has no line and no payslip. Payroll never
  recalculates wages: it reads the approved sheet and the reconciliation from the wages module.
- **Cost finalization** (BR-2): finalizing moves the month's approved attendance cost entries to `posted`
  and checks them against the wage reconciliation. The difference between the wage sheet gross and that
  cost is posted as `payroll_adjustment` entries (source module `payroll`), spread to the projects pro
  rata to their attendance cost with the largest-remainder method (H-29 default), or all to overhead.
  Only these entries may be negative (payroll lower than attendance cost).
- **Payslips** (BR-3): numbered from series `PSL` when the run is finalized (a reopened run keeps its
  numbers). The payroll screens never show the rate; the service shows it only to the worker themself.
- **Payment** (BR-4, BR-6): `payment-requests` asks the owner to approve the selected lines (H-09: every
  payment, the cash book's band decides); `pay` records one cash book payment per call, or per line when
  `payroll_cash_txn_per_line` is on. The approver cannot be the user who finalized the run (here) or the
  one who records the payment (the cash book). The run status follows the lines.
- **Reversal and reopening** (BR-5, BR-7): a payment is reversed with a reason through the cash book and
  its lines are unpaid again. An unpaid finalized run can be reopened; that reverses the cost
  finalization and puts the attendance cost back to `approved`. A run that is no longer a draft refuses
  `wages.periods.reopen` through `hasPaidLines`.
- **Sensitive data** (BR-8): payroll stores no bank or wallet details.

Not here: statutory deductions, bank file formats, wallet integrations, final settlement of leavers.
Because the cash book honours only its own document type, a payment request is a `payment` document whose
context says it is wages of the run.
