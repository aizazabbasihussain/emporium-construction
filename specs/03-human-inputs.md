# 03. Human Inputs Register

Decisions only the business, the accountant or a consultant can make. The agent never guesses these. `pnpm spec:check` fails if a spec requires an H-id that does not exist.

Status: `open` or `answered`. "Default allowed": whether the agent may proceed with the stated default when the input is still `open` (the default is then recorded in the PR for review).

| ID | Decision | Owner | Needed by | Default allowed | Default | Status |
|---|---|---|---|---|---|---|
| H-01 | Tax registrations: FBR number(s); is PRA registration needed for Punjab work; registration numbers per authority | Accountant | P1-05, P2-01 | no | none | open |
| H-02 | Sales tax rules and rates by authority, service type and location (effective-dated) | Accountant | P2-01 | no | none | open |
| H-03 | Withholding tax rules: tax withheld by clients; tax withheld from vendors and subcontractors; rates and bases | Accountant | P2-01 | no | none | open |
| H-04 | Tax-invoice numbering: format, series per authority, must it be gapless | Accountant | P1-01, P2-02 | no | none | open |
| H-05 | Chart of accounts (codes, names, types) | Accountant | P0-03, P2-09 | no | none | open |
| H-06 | Fiscal year start month | Accountant | P2-09 | yes | July | open |
| H-07 | Initial stock valuation policy: company default method (weighted_average or fifo) and any category overrides | Accountant | P1-13 | yes | company default weighted_average, no overrides | open |
| H-08 | Tax rounding: per line or per document | Accountant | P2-01 | yes | per document | open |
| H-09 | Approval matrix and amount limits (requisition, PO, expense, payment, quotation margin floor, write-offs) | Owner | P1-03 and all approvers | no | none | open |
| H-10 | Role holders: which people hold which roles | Owner | P1-02 | no | none | open |
| H-11 | Wage rules: working-days basis per month (26 or 30), overtime multiplier, rounding of net pay | Owner, accountant | P1-17, P1-18 | no | none | open |
| H-12 | Worker pay basis and rates (daily rate or monthly salary) | Owner | P1-16 | no | none | open |
| H-13 | Opening data: cash, bank, receivables, payables, advances, PDCs, stock, open projects, workers, vendors, clients | Accountant, owner | P0-04, P2-10 | no | none | open |
| H-14 | Samples of paper forms (quotation, site report, voucher, labour register, attendance sheet, invoice) | Owner | P0-02 | yes | specs' own fields | open |
| H-15 | Job templates and unit rates (boundary wall, room, slab, demolition, others) | Owner | P1-07 | no | none | open |
| H-16 | Lead sources, pipeline stages, loss reasons | Owner | P1-06 | yes | stages: New, Visited, Quoted, Negotiation, Won, Lost | open |
| H-17 | Government contract terms: Pakistan-only storage wording, backups covered or not | Owner | Phase 4 | no | none | open |
| H-18 | Hosting provider shortlist and quotes | Owner | Phase 4 | no | none | open |
| H-19 | Independent reviewer for security and financial logic | Owner | P1-21, P2-10 | no | none | open |
| H-20 | Maintenance billing model (per job, per visit, time and materials), SLA targets, rate cards, parts markup | Owner | P3-01, P3-04 | no | none | open |
| H-21 | Salvaged material valuation: zero or estimated value | Accountant | P1-12 | yes | zero value | open |
| H-22 | Purchase price variance handling (bill price differs from receipt price) | Accountant | P2-05 | yes | variance charged to project cost if issued, else to an overhead cost code | open |
| H-23 | Over-receipt tolerance and three-way match tolerances | Owner | P1-11, P2-05 | yes | 0% over-receipt; match tolerance 0 | open |
| H-24 | Backdating allowance (days a business date may precede today) | Owner | P1-01 | yes | 3 days | open |
| H-25 | Cost code structure (hierarchy and codes) | Owner, accountant | P1-05 | no | none | open |
| H-26 | Units of measure and conversions | Owner | P1-05 | yes | standard construction units (nos, bag, kg, ton, m, ft, sqft, sqm, cuft, cum, day, hour, ls) | open |
| H-27 | Document number series and starting numbers continuing the paper series | Accountant | P1-01 | no | none | open |
| H-28 | Advance recovery method on stage invoices (proportional or fixed percentage) | Accountant | P2-02 | yes | proportional to invoice share of contract value | open |
| H-29 | Labour cost difference handling (allocated attendance cost vs final payroll): spread to projects or overhead | Accountant | P2-07 | yes | spread pro-rata to the projects in the payroll month | open |
| H-30 | Aging buckets and credit follow-up rules | Owner | P2-04 | yes | 0-30, 31-60, 61-90, 90+ days | open |
