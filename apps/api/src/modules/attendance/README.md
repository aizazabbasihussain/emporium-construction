# attendance

Daily attendance sheets per team and date, and the labour cost they allocate to projects (spec
P1-17). A supervisor records each worker's day against one or more projects; the project manager
approves the sheet through the approval engine, and approval books `approved` cost entries in the
project cost ledger. It computes no payroll (P1-18). Public entry point: `index.ts`. Business
rules live in `packages/domain/src/attendance`.
