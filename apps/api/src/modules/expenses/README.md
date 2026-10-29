# expenses

Site expense claims, cash advances to custodians and the custodian balance (spec P1-14). A claim
goes through the approval engine; approval books one `approved` cost entry per line in the project
cost ledger and the accountant's posting moves each to `posted`. The module moves no cash. Public
entry point: `index.ts`. Business rules live in `packages/domain/src/expenses`.
