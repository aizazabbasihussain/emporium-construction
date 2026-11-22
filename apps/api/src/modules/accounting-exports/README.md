# accounting-exports

Accountant exports and account tags (spec P2-09). The internal accountant keeps the official books outside the system; this module hands over registers, ledgers and reports in fixed layouts, with each document line carrying the chart-of-accounts code it belongs to. It is not a general ledger: it keeps no journal, balance, trial balance or statement.

## What it owns

Four tables:

- `acc_accounts`: the chart of accounts (H-05, accepted provisionally; seeded by migration 0033). Read-only except switching an account on or off.
- `acc_mapping_rules`: posting suggestions per document type. A rule names a document type, optional conditions on the document (for example `kind=advance`), a debit and a credit account, and the date it takes effect.
- `acc_tags`: the tag of one document line. A tag is never changed by a rule; only the accountant changes it.
- `acc_export_runs`: one row per export run (code, schema version, filters, row count, checksum, the Excel file). Never updated.

## Where the figures come from

Every export reads rows from the owning modules' exported query functions (`adapters/sources.ts`) and is checked against a figure the same module reports through another function (BR-5):

| Export                     | Rows                                    | Control                                       |
| -------------------------- | --------------------------------------- | --------------------------------------------- |
| `sales_register`           | billing invoices and credit notes       | `billing.getProjectBilling` at both ends      |
| `purchase_register`        | payables bills                          | `payables.getVendorBalance` at both ends      |
| `receipts_register`        | receivables receipts                    | `receivables.getCustomerBalance` at both ends |
| `payments_register`        | payables payments                       | `payables.getVendorBalance` at both ends      |
| `cash_bank_book`           | cash book transactions                  | `cashbook.getAccountBalance` at both ends     |
| `pdc_register`             | receivables cheque register             | the register's status totals                  |
| `customer_ledger`          | receivables statements                  | closing less opening of each statement        |
| `vendor_ledger`            | payables vendor ledger                  | `payables.getVendorBalance` at both ends      |
| `aging`                    | receivables and payables aging          | the total of each aging report                |
| `withholding_report`       | payables withholding, receipts withheld | `tax.taxReportData` per authority and month   |
| `payroll_summary`          | payroll runs                            | `payroll.runs.getPayrollRun`                  |
| `stock_valuation`          | valuation stock value report            | the report's total value                      |
| `project_cost_profit`      | profitability project figures           | the project cost ledger (`projects`)          |
| `subcontractor_statements` | subcontracts statements                 | the statement totals                          |

A difference aborts the run with `control_total_mismatch` and nothing is stored. The layout of each export is in `docs/exports/<code>.md`; a test compares the documents with `packages/domain/src/accounting/layouts.ts`.

## Rules worth knowing

- The tag takes the account the document is about, not the cash side: the credit account of an invoice or receipt, the debit account of a credit note, bill or vendor payment; a cash transaction and a stock movement use their direction (`packages/domain/src/accounting/rules.ts`, `tagSide`).
- Of the rules that fit, the one naming more conditions wins, then the later start date, then the smaller id.
- Tags are made on the document (line reference blank). Line-level tags are in `specs/BACKLOG.md`.
- The checksum is taken over the data section only (column keys and rows). The same data gives the same checksum on any day.
- The fiscal year start month is the setting `accounting.fiscal_year_start_month` (default 7, H-06). It labels and filters only; nothing is closed or locked.
- The files of a run are stored through the file store with the entity type `acc_export_run`: the run stores them (the caller needs no upload permission), whoever may read or run exports can open them, and nobody removes them.
