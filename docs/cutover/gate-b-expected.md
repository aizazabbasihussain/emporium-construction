# Gate B expected figures (hand-calculated worksheet)

This is the worksheet behind the Gate B finance scenario (`apps/api/src/acceptance/gate-b.finance.test.ts`, spec P2-10 BR-2 and BR-3). Every figure was worked out by hand from the inputs below, before the scenario was run; the scenario reads the value column of this file and compares it to what the API returns, to the paisa. If a number here changes, a person must redo the calculation and explain why.

All data is synthetic. Dates are in November 2026. Money is PKR, rounded half-up to 2 decimals. The tax rates and withholding rates below are test values entered as data through the rule screens (H-02, H-03); they say nothing about the real company.

## Inputs

| Input                | Value                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tax rules            | Services: FBR 8% (Islamabad), PRA 16% (Punjab). Goods: FBR 18% (both regions)                                                               |
| Withholding rules    | Client withholds from us: FBR 5% of the base, PRA 2% of the tax. We withhold from subcontractors: FBR 4% of the base                        |
| Cash accounts        | Head office cash 500,000.00 and Synthetic Bank 2,000,000.00, both opened on 1 Nov                                                           |
| Islamabad project    | Contract 1,000,000.00; stage 1 of 400,000.00; budget 700,000.00                                                                             |
| Lahore project       | Contract 800,000.00; stage 1 of 500,000.00; budget 700,000.00; advance of 100,000.00                                                        |
| Receipts             | Islamabad: cheque 192,000.00 plus 20,000.00 withheld. Lahore: cheque 300,000.00 (bounced), then transfer 215,900.00 plus 1,600.00 withheld  |
| Credit note          | 10,000.00 base against the Islamabad invoice                                                                                                |
| Purchase             | 100 bags ordered at 1,200.00, received in full, billed at 1,230.00; 40 bags issued to the Lahore project                                    |
| Subcontract          | Work order 200,000.00, certificate at 50% cumulative, back-charge 5,000.00 that recovers cost                                               |
| Payments             | Cheque 100,000.00 and cash 45,140.00 to the vendor; transfer to the subcontractor                                                           |
| Workers (2 to 7 Nov) | Mason 1,500.00/day with 2 h overtime; helper 1,000.00/day, 1 day absent; foreman 39,000.00/month, 5 days and 1 half day                     |
| Wage settings        | 26 working days a month; overtime at 1.5 times the hourly rate (daily rate / 8); net rounded to the rupee                                   |
| Bank statement       | Closing 2,424,600.00 with the 100,000.00 cheque not presented and a 500.00 bank charge not yet in the books                                 |

## Worksheet

| Id                      | Expected     | Calculation                                                                                                   |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `tax.praServices`       | `16000.00`   | 16% of 100,000.00                                                                                             |
| `adv.invoice.gross`     | `116000.00`  | Advance 100,000.00 plus 16% PRA tax 16,000.00                                                                 |
| `adv.netBilled`         | `100000.00`  | The advance invoice base                                                                                      |
| `adv.unapplied`         | `100000.00`  | No stage invoice has recovered any of it yet                                                                  |
| `isb.stage.tax`         | `32000.00`   | 8% of 400,000.00                                                                                              |
| `isb.stage.gross`       | `432000.00`  | 400,000.00 + 32,000.00                                                                                        |
| `isb.stage.withholding` | `20000.00`   | 5% of the 400,000.00 base                                                                                     |
| `lhr.stage.tax`         | `80000.00`   | 16% of 500,000.00                                                                                             |
| `lhr.stage.recovery`    | `62500.00`   | Proportional advance recovery: 100,000 / 800,000 x 500,000                                                    |
| `lhr.stage.gross`       | `517500.00`  | 500,000.00 + 80,000.00 - 62,500.00                                                                            |
| `lhr.stage.withholding` | `1600.00`    | 2% of the 80,000.00 tax                                                                                       |
| `lhr.balance.afterBounce` | `517500.00` | The bounced cheque is not a payment: the whole invoice is open                                              |
| `cn.tax`                | `800.00`     | 8% of 10,000.00                                                                                               |
| `cn.gross`              | `10800.00`   | 10,000.00 + 800.00                                                                                            |
| `isb.balance`           | `209200.00`  | 432,000.00 - 10,800.00 credit - 192,000.00 received - 20,000.00 withheld                                      |
| `lhr.balance`           | `300000.00`  | 517,500.00 - 215,900.00 received - 1,600.00 withheld                                                          |
| `po.total`              | `120000.00`  | 100 x 1,200.00                                                                                                |
| `bill.base`             | `123000.00`  | 100 x 1,230.00                                                                                                |
| `bill.rateVariance`     | `30.0000`    | 1,230.00 billed - 1,200.00 ordered                                                                            |
| `bill.tax`              | `22140.00`   | 18% FBR goods rate on 123,000.00                                                                              |
| `bill.gross`            | `145140.00`  | 123,000.00 + 22,140.00                                                                                        |
| `bill.variance`         | `3000.00`    | 100 bags x 30.00, booked as a price variance                                                                  |
| `cert.net`              | `100000.00`  | 50% of 200,000.00 (before the back-charge is attached)                                                        |
| `sub.base`              | `95000.00`   | 100,000.00 certified - 5,000.00 back-charge                                                                   |
| `sub.tax`               | `7600.00`    | 8% of 95,000.00 (Islamabad services)                                                                          |
| `sub.gross`             | `102600.00`  | 95,000.00 + 7,600.00                                                                                          |
| `sub.withholding`       | `3800.00`    | 4% of the 95,000.00 base                                                                                      |
| `sub.netPayable`        | `98800.00`   | 102,600.00 - 3,800.00                                                                                         |
| `wage.gross`            | `22812.50`   | Mason 9,000.00 + 562.50 overtime; helper 5,000.00; foreman 39,000 / 26 x 5.5 = 8,250.00                       |
| `wage.net`              | `22813.00`   | Mason 9,562.50 rounds to 9,563.00; the others are whole rupees                                                |
| `bank.balance`          | `2325100.00` | 2,000,000.00 + 116,000.00 + 192,000.00 + 215,900.00 - 100,000.00 - 98,800.00                                  |
| `cash.balance`          | `432047.00`  | 500,000.00 - 45,140.00 - 22,813.00                                                                            |
| `rec.statementClosing`  | `2424600.00` | Book 2,325,100.00 + 100,000.00 cheque not presented - 500.00 bank charge                                      |
| `stock.issue`           | `48000.00`   | 40 bags at the receipt cost of 1,200.00                                                                       |
| `tax.fbr.output.base`   | `390000.00`  | 400,000.00 invoice - 10,000.00 credit note                                                                    |
| `tax.fbr.output.tax`    | `31200.00`   | 32,000.00 - 800.00                                                                                            |
| `tax.fbr.input.base`    | `218000.00`  | Bills 123,000.00 + 95,000.00                                                                                  |
| `tax.fbr.input.tax`     | `29740.00`   | 22,140.00 + 7,600.00                                                                                          |
| `tax.pra.output.base`   | `600000.00`  | Advance 100,000.00 + stage invoice 500,000.00                                                                 |
| `tax.pra.output.tax`    | `96000.00`   | 16,000.00 + 80,000.00                                                                                         |
| `tax.fbr.suffered`      | `20000.00`   | Tax the Islamabad client withheld against an FBR invoice (finding F-3)                                        |
| `purchase.gross`        | `247740.00`  | 145,140.00 + 102,600.00                                                                                       |
| `purchase.netPayable`   | `243940.00`  | 247,740.00 - 3,800.00                                                                                         |
| `receipts.amount`       | `523900.00`  | 116,000.00 + 192,000.00 + 215,900.00 (cleared receipts)                                                       |
| `receipts.withheld`     | `21600.00`   | 20,000.00 + 1,600.00                                                                                          |

### Project profitability, Islamabad (1,000,000.00 contract)

| Id                                | Expected     | Calculation                                                                              |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `pft.isb.contractValue`           | `1000000.00` | Original contract value, no variations                                                   |
| `pft.isb.billedBase`              | `390000.00`  | 400,000.00 - 10,000.00 credit note                                                       |
| `pft.isb.billedTax`               | `31200.00`   | 32,000.00 - 800.00                                                                       |
| `pft.isb.billedGross`             | `421200.00`  | 432,000.00 - 10,800.00                                                                   |
| `pft.isb.billedPercent`           | `39.00`      | 390,000 / 1,000,000                                                                      |
| `pft.isb.collectedGross`          | `212000.00`  | 192,000.00 received + 20,000.00 withheld                                                 |
| `pft.isb.collectedBase`           | `196296.30`  | 212,000 / 421,200 x 390,000                                                              |
| `pft.isb.withheldTax`             | `20000.00`   | Withheld by the client                                                                   |
| `pft.isb.collectedPercent`        | `19.63`      | 196,296.30 / 1,000,000                                                                   |
| `pft.isb.outstandingReceivable`   | `209200.00`  | 421,200.00 - 212,000.00                                                                  |
| `pft.isb.committed`               | `100000.00`  | Work order 200,000.00 less 100,000.00 certified                                          |
| `pft.isb.approved`                | `0.00`       | Attendance cost became posted when payroll was finalized                                 |
| `pft.isb.posted`                  | `117812.50`  | Labour 22,812.50 + certified 100,000.00 - back-charge 5,000.00                           |
| `pft.isb.costToDate`              | `217812.50`  | 100,000.00 + 0.00 + 117,812.50                                                           |
| `pft.isb.budget`                  | `700000.00`  | 400,000.00 + 300,000.00                                                                  |
| `pft.isb.costPercentOfBudget`     | `31.12`      | 217,812.50 / 700,000                                                                     |
| `pft.isb.costToComplete`          | `482187.50`  | 700,000.00 - 217,812.50                                                                  |
| `pft.isb.expectedMargin`          | `300000.00`  | 1,000,000.00 - (217,812.50 + 482,187.50)                                                 |
| `pft.isb.expectedMarginPercent`   | `30.00`      | 300,000 / 1,000,000                                                                      |
| `pft.isb.currentMargin`           | `272187.50`  | Billed base 390,000.00 - posted 117,812.50 - approved 0.00                               |
| `pft.isb.currentMarginPercent`    | `69.79`      | 272,187.50 / 390,000                                                                     |
| `pft.isb.paidOutVendors`          | `102600.00`  | Subcontractor payment 98,800.00 + 3,800.00 withheld                                      |
| `pft.isb.paidOutWages`            | `22813.00`   | Payroll paid in cash                                                                     |
| `pft.isb.paidOutExpenses`         | `0.00`       | No expense claims in this scenario                                                       |
| `pft.isb.paidOut`                 | `125413.00`  | 102,600.00 + 22,813.00                                                                   |
| `pft.isb.cashPosition`            | `86587.00`   | Collected 212,000.00 - paid out 125,413.00                                               |

### Project profitability, Lahore (800,000.00 contract)

The billed base, collected base and current margin of this project are an open question (Q-1 in `docs/cutover/gate-b-findings.md`) and are not part of the worksheet.

| Id                                | Expected    | Calculation                                              |
| --------------------------------- | ----------- | -------------------------------------------------------- |
| `pft.lhr.contractValue`           | `800000.00` | Original contract value                                  |
| `pft.lhr.billedGross`             | `517500.00` | The stage invoice, net of the advance it recovers        |
| `pft.lhr.collectedGross`          | `217500.00` | 215,900.00 received + 1,600.00 withheld                  |
| `pft.lhr.outstandingReceivable`   | `300000.00` | 517,500.00 - 217,500.00                                  |
| `pft.lhr.committed`               | `0.00`      | No subcontract on this project                           |
| `pft.lhr.approved`                | `0.00`      | Nothing waiting for finance confirmation                 |
| `pft.lhr.posted`                  | `48000.00`  | 40 bags issued at 1,200.00                               |
| `pft.lhr.costToDate`              | `48000.00`  | 0.00 + 0.00 + 48,000.00                                  |
| `pft.lhr.budget`                  | `700000.00` | 400,000.00 + 300,000.00                                  |
| `pft.lhr.costPercentOfBudget`     | `6.86`      | 48,000 / 700,000                                         |
| `pft.lhr.costToComplete`          | `652000.00` | 700,000.00 - 48,000.00                                   |
| `pft.lhr.expectedMargin`          | `100000.00` | 800,000.00 - (48,000.00 + 652,000.00)                    |
| `pft.lhr.expectedMarginPercent`   | `12.50`     | 100,000 / 800,000                                        |
| `pft.lhr.paidOutVendors`          | `145140.00` | Cheque 100,000.00 + cash 45,140.00 for the cement bill   |
| `pft.lhr.paidOutWages`            | `0.00`      | No labour on this project                                |
| `pft.lhr.paidOut`                 | `145140.00` | Vendors only                                             |
| `pft.lhr.cashPosition`            | `72360.00`  | Collected 217,500.00 - paid out 145,140.00               |
