# Opening control sheet

The accountant's control totals for the opening data load (spec P2-10 BR-1). `pnpm cutover:verify-opening` compares each total below with what the system holds after the load; every difference must be zero to the paisa.

**This sheet holds synthetic rehearsal figures.** The real sheet is filled in by the accountant from the books at the cut-over date (input H-13: only open items are loaded: unpaid client invoices, unpaid vendor bills, open projects, and the current cash, bank, advance, post-dated cheque and stock balances). Until then the real load cannot happen.

Rules for the table: one row per control total; the key is a lowercase code; money has two decimals and no thousands separators.

The key of a cash or bank account is its kind and its account code in lowercase, for example account `CASH-HO` of kind `cash` is `cash.cash_ho`.

| Key           | What                                   | Total        |
| ------------- | -------------------------------------- | ------------ |
| `cash.cash_ho` | Head office cash on hand (CASH-HO)     | `500000.00`  |
| `bank.bank_1`  | Synthetic Bank current account (BANK-1) | `2000000.00` |

## Totals still to be added by the accountant (H-13)

These categories have no importer yet (see the deviation recorded in the P2-10 pull request). Rows are added here when the importers exist and the real figures are known.

- `receivables.open_invoices`: total of unpaid client invoices
- `payables.open_bills`: total of unpaid vendor bills
- `advances.received`, `advances.paid`: advances not yet recovered
- `pdc.in_hand`: post-dated cheques held
- `projects.cost_to_date`: cost to date of open projects
- `stock.value`: opening stock at valued cost
