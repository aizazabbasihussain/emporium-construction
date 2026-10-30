# wages

Monthly wage calculation (spec P1-18). From the approved attendance of a month it prices every
worker's days, overtime, allowances, deductions and advance recoveries into a wage sheet, which the
owner approves through the approval engine. Payment, payslips and cost finalization follow in
P2-07. Public entry point: `index.ts`. Business rules live in `packages/domain/src/wages`.
