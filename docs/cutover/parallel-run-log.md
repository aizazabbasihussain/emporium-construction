# Parallel run log

Spec P2-10 BR-9. For the agreed period (one to two months) the accountant compares, each working day, the paper books with the system and records the result here. A check cell holds `ok`, or the difference in words. The `Unexplained` column counts differences nobody can explain yet. **Paper stops only when the last 10 working days all show 0 unexplained.** `apps/api/src/acceptance/cutover.test.ts` checks the format of this table.

| Date | Cash | Invoices | Receipts | Payments | Stock issues | Attendance | Unexplained | Note |
| ---- | ---- | -------- | -------- | -------- | ------------ | ---------- | ----------- | ---- |

Paper may stop: no. (Change to `yes` only after the last 10 working days above show 0 unexplained.)

_No days recorded: the parallel run has not started (it needs the cut-over date, input H-13)._
