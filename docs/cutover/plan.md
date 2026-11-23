# Cutover plan

Spec P2-10 BR-8. How the company moves from paper to the system. Dates in brackets are decided by the owner and accountant (input H-13); nothing here has been scheduled.

## 1. Cutover date

At a clean month boundary: the first day of a month after the last paper month is closed. **[Date to be set by the owner.]** The owner and the accountant approve the date in writing below.

## 2. Freeze of paper entries

From the close of business on the last day before the cutover date, no new paper voucher, invoice or register entry is made for the loaded categories. Entries made after the freeze are recorded in the system only. The accountant keeps the last paper totals as the control sheet (`docs/cutover/opening-control-sheet.md`).

## 3. Opening load steps

Through the import framework, in dependency order, each step dry-run first and committed only when it has no errors:

1. Parties (clients, vendors, subcontractors), items, workers and pay rates.
2. Cash and bank accounts with their balances.
3. Opening vendor and customer balances (open bills and invoices only), advances, post-dated cheques in hand.
4. Open projects with cost to date.
5. Opening stock through receipts without a goods receipt note, at valued cost.

Steps 2 to 5 need importers that do not exist yet (recorded as a deviation of P2-10).

## 4. Verification steps

1. Take a backup immediately before the load (see section 5).
2. Run `pnpm cutover:verify-opening` against the control sheet. Every difference must be zero.
3. Run the reconciliations (`pnpm gate:b`) on the loaded database.
4. The accountant signs the verification result.

## 5. Rollback plan

Restore the backup taken before the load (BR-6 rehearsal: `apps/api/src/acceptance/backup.ts`), then repeat from the load steps once the cause is fixed. Rollback is possible until the first live entry is made; after that a correction is made by a normal reversing entry, never by restore.

## 6. Parallel run

One to two months, depending on how soon the last 10 working days are clean. Each day the accountant fills in one row of `docs/cutover/parallel-run-log.md`: cash position, new invoices, receipts, payments, stock issues and attendance counts. Paper stops when the last 10 working days have zero unexplained differences.

A daily comparison sheet is the same table printed for the accountant: one row per day, one column per check.

## 7. Training schedule per role

| Role                 | Content                                                  | When                         |
| -------------------- | -------------------------------------------------------- | ---------------------------- |
| Accountant           | Invoices, receipts, bills, payments, cash book, exports  | Two weeks before the cutover |
| Owner                | Approvals, dashboards, profitability                     | One week before              |
| Project manager      | Billing schedule, certificates, project costs            | One week before              |
| Procurement officer  | Purchase orders, goods receipt, bill matching            | One week before              |
| Store keeper         | Receipts, issues, stock counts                           | One week before              |
| Site supervisor      | Attendance, site reports, requests                       | Week of the cutover          |

## Approval

| Field           | Value                |
| --------------- | -------------------- |
| Approved by (owner)      | **Not approved yet.** |
| Approved by (accountant) | **Not approved yet.** |
