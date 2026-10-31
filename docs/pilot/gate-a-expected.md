# Gate A expected figures (hand-calculated worksheet)

This is the worksheet behind the Gate A end-to-end scenario (`apps/api/src/acceptance/scenario.test.ts`, spec P1-21 BR-2 and BR-3). Every figure was worked out by hand from the inputs below; the scenario reads the value column of this file and compares it to what the API returns, to the paisa. If a number here changes, a person must redo the calculation and explain why.

All data is synthetic. Dates are in October 2026. Money is PKR, rounded half-up to 2 decimals.

## Inputs

| Input                      | Value                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Template quantities        | Boundary wall of 100 m: cement `length * 2` bags, labour `length * 1.5` days        |
| Rates                      | Cement 1,250.00 per bag (estimate); labour 1,200.00 per day                         |
| Estimate terms             | Overhead 10%, contingency 5%, target margin 20%                                     |
| Quotation stages           | 30% advance, 70% on completion                                                      |
| Purchase order 1           | 200 bags at 1,240.00; 120 bags received in a partial receipt                        |
| Purchase order 2           | 100 bags at 1,300.00, received in full after the switch to FIFO                     |
| Issues to the project      | 50 bags (weighted average), then 90 bags (FIFO)                                     |
| Client-supplied tiles      | 40 sqm received, 25 sqm used                                                        |
| Variation                  | Cost 40,000.00, price 52,000.00                                                     |
| Site expense claim         | 2,000.00 and 1,500.50                                                               |
| Workers (6 days, 26-31 Oct) | Mason 1,500.00/day with 2 h overtime; helper 1,000.00/day, 1 day absent; foreman 39,000.00/month, 5 days and 1 half day |
| Wage settings              | 26 working days a month; overtime at 1.5 times the hourly rate (daily rate / 8); net rounded to the rupee |

## Worksheet

| Id                         | Expected    | Calculation                                                         |
| -------------------------- | ----------- | ------------------------------------------------------------------- |
| `estimate.companyCost`     | `430000.00` | 200 bags x 1,250.00 = 250,000.00; 150 days x 1,200.00 = 180,000.00  |
| `estimate.overhead`        | `43000.00`  | 10% of 430,000.00                                                   |
| `estimate.contingency`     | `21500.00`  | 5% of 430,000.00                                                    |
| `estimate.totalCost`       | `494500.00` | 430,000.00 + 43,000.00 + 21,500.00                                  |
| `quotation.price`          | `618125.00` | 494,500.00 / (1 - 0.20): a 20% margin on the price                  |
| `quotation.stage1`         | `185437.50` | 30% of 618,125.00                                                   |
| `quotation.stage2`         | `432687.50` | 618,125.00 - 185,437.50                                             |
| `project.contractValue`    | `618125.00` | The accepted quotation price                                        |
| `po1.total`                | `248000.00` | 200 x 1,240.00                                                      |
| `stock.afterGrn1`          | `120.0000`  | Partial receipt of 120 of 200 bags                                  |
| `issue1.value`             | `62000.00`  | 50 bags at the weighted average 1,240.00                            |
| `transition.quantity`      | `70.0000`   | 120 - 50 bags carried into FIFO                                     |
| `transition.valueBefore`   | `86800.00`  | 70 x 1,240.00                                                       |
| `transition.valueAfter`    | `86800.00`  | Unchanged by the switch (conservation)                              |
| `po2.total`                | `130000.00` | 100 x 1,300.00                                                      |
| `issue2.value`             | `112800.00` | FIFO: 70 x 1,240.00 = 86,800.00 plus 20 x 1,300.00 = 26,000.00      |
| `stock.afterIssue2`        | `80.0000`   | 70 + 100 - 90 bags                                                  |
| `client.received`          | `40.0000`   | Client-supplied tiles received                                      |
| `client.used`              | `25.0000`   | Used on the project, no cost                                        |
| `client.balance`           | `15.0000`   | 40 - 25                                                             |
| `variation.priceImpact`    | `52000.00`  | Approved variation price                                            |
| `contract.current`         | `670125.00` | 618,125.00 + 52,000.00                                              |
| `expense.total`            | `3500.50`   | 2,000.00 + 1,500.50 posted on cost code 500                         |
| `wage.mason.basic`         | `9000.00`   | 6 days x 1,500.00                                                   |
| `wage.mason.overtime`      | `562.50`    | 2 h x (1,500.00 / 8 x 1.5 = 281.25)                                 |
| `wage.mason.net`           | `9563.00`   | 9,562.50 rounded to the rupee (half up)                             |
| `wage.helper.net`          | `5000.00`   | 5 days x 1,000.00                                                   |
| `wage.foreman.net`         | `8250.00`   | 39,000.00 / 26 = 1,500.00 x 5.5 days                                |
| `wage.gross`               | `22812.50`  | 9,562.50 + 5,000.00 + 8,250.00                                      |
| `wage.net`                 | `22813.00`  | 9,563.00 + 5,000.00 + 8,250.00                                      |
| `cost.budget`              | `470000.00` | 250,000.00 + 180,000.00 + 40,000.00 (variation cost added)          |
| `cost.posted`              | `178300.50` | 62,000.00 + 112,800.00 + 3,500.50                                   |
| `cost.approved`            | `22812.50`  | Labour from approved attendance (equals the gross wage)             |
| `cost.used`                | `201113.00` | 178,300.50 + 22,812.50                                              |
| `cost.variance`            | `268887.00` | 470,000.00 - 201,113.00                                             |
| `cost.percentUsed`         | `42.79`     | 201,113.00 / 470,000.00 = 42.79%                                    |
