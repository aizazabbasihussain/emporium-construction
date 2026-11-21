# profitability

Project profitability and contract tracking (spec P2-08). Per project: contract value against cost, billing and cash collected, so the owner sees margin, receivables exposure and cash position on every job.

## What it owns

Three tables, none of which holds a financial figure that another module owns (AC-3):

- `pft_thresholds`: the margin floor, overspend limit and receivable age limit, for the company or for one project.
- `pft_forecasts`: manual cost-to-complete forecasts. Each is a new row; the latest made on or before the date asked is used.
- `pft_alert_state`: which alert is open for which project, with when it was raised and cleared.

## Where the figures come from

Everything is composed at read time, for any `asOf` date, from the owning modules' exported query functions (BR-6):

| Figure                                            | Source                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Contract value                                    | `variations.getCurrentContractValue(projectId, asOf)`                                              |
| Budget, cost by status                            | `projects.getCostSummary(costObject, asOf)`                                                        |
| Billed (base, tax, gross)                         | `billing.getProjectBilling(projectId, asOf)`                                                       |
| Collected (gross, withheld, base), receivable age | `receivables.getProjectCollected`, `receivables.getProjectAging`                                   |
| Paid out                                          | `payables.getPaidForProject`, `payroll.getPaidWagesForProject`, `expenses.getReimbursedForProject` |

The calculations are pure functions in `packages/domain/src/profitability` (percent rounding, cost to complete, margins, cash position, alert conditions and the risk order).

## Definitions worth knowing

- **Billed** is the issued invoices that are not advance invoices, net of credit notes, before advance recovery. **Collected** is the receipts allocated to those invoices; gross includes the tax withheld and certified, and unapplied advances are not part of it.
- **Expected margin** is contract value less cost to date (committed, approved and posted) less cost to complete (the latest manual forecast, else the unused budget, never below zero). **Current margin** is billed base less posted and approved cost. They are always labelled apart.
- **Cash position** is collected gross less paid out; negative means the company has funded the project.
- A percent of a zero base is `null`, never an error.

## Alerts

`evaluateAlerts` (run hourly by the scheduler) compares the conditions with the stored state: a condition that became true is raised once and the project manager and management are notified; one that is no longer true is cleared. No thresholds are seeded, so no alert is raised until management sets them.

## Layout

`routes/` HTTP handlers, `service/` orchestration, `policy/` permission and visibility guards, `repo/` SQL on the three owned tables. Exports reuse the shared export helper of the reports module (header block, CSV and Excel).
