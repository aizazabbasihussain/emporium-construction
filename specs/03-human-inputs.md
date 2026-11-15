# 03. Human Inputs Register

Decisions only the business, the accountant or a consultant can make. The agent never guesses these. `pnpm spec:check` fails if a spec requires an H-id that does not exist.

Status: `open` or `answered`. "Default allowed": whether the agent may proceed with the stated default when the input is still `open` (the default is then recorded in the PR for review).

| ID | Decision | Owner | Needed by | Default allowed | Default | Status |
|---|---|---|---|---|---|---|
| H-01 | Tax registrations: FBR number(s); is PRA registration needed for Punjab work; registration numbers per authority | Accountant | P1-05, P2-01 | no | none | answered |
| H-02 | Sales tax rules and rates by authority, service type and location (effective-dated) | Accountant | P2-01 | yes | FBR only; one sales tax rule of 8% on services, loaded as data (not seeded); rules effective-dated and editable | answered |
| H-03 | Withholding tax rules: tax withheld by clients; tax withheld from vendors and subcontractors; rates and bases | Accountant | P2-01 | yes | no withholding rules until an admin enters them; the engine and screens are fully configurable | answered |
| H-04 | Tax-invoice numbering: format, series per authority, must it be gapless | Accountant | P1-01, P2-02 | no | none | answered |
| H-05 | Chart of accounts (codes, names, types) | Accountant | P0-03, P2-09 | no | none | answered |
| H-06 | Fiscal year start month | Accountant | P2-09 | yes | July | answered |
| H-07 | Initial stock valuation policy: company default method (weighted_average or fifo) and any category overrides | Accountant | P1-13 | yes | company default weighted_average, no overrides | open |
| H-08 | Tax rounding: per line or per document | Accountant | P2-01 | yes | per document | answered |
| H-09 | Approval matrix and amount limits (requisition, PO, expense, payment, quotation margin floor, write-offs) | Owner | P1-03 and all approvers | no | none | answered |
| H-10 | Role holders: which people hold which roles | Owner | P1-02 | no | none | answered |
| H-11 | Wage rules: working-days basis per month (26 or 30), overtime multiplier, rounding of net pay | Owner, accountant | P1-17, P1-18 | yes | working-days basis 26, overtime multiplier 1.5, net pay rounded to nearest PKR 1; all editable settings, not constants | answered |
| H-12 | Worker pay basis and rates (daily rate or monthly salary) | Owner | P1-16 | yes | build with synthetic data; rates are per worker, effective-dated and entered by an admin from the screen, none in code | open |
| H-13 | Opening data: cash, bank, receivables, payables, advances, PDCs, stock, open projects, workers, vendors, clients | Accountant, owner | P0-04, P2-10 | yes | synthetic opening data via the import templates; real balances loaded later through the importer | open |
| H-14 | Samples of paper forms (quotation, site report, voucher, labour register, attendance sheet, invoice) | Owner | P0-02 | yes | specs' own fields | open |
| H-15 | Job templates and unit rates (boundary wall, room, slab, demolition, others) | Owner | P1-07 | yes | build the editor and evaluator; templates are data loaded by an admin, rates empty, overhead 10%, contingency 5%, margin 15% as editable settings | open |
| H-16 | Lead sources, pipeline stages, loss reasons | Owner | P1-06 | yes | stages: New, Visited, Quoted, Negotiation, Won, Lost | open |
| H-17 | Government contract terms: Pakistan-only storage wording, backups covered or not | Owner | Phase 4 | no | none | open |
| H-18 | Hosting provider shortlist and quotes | Owner | Phase 4 | no | none | open |
| H-19 | Independent reviewer for security and financial logic | Owner | P1-21, P2-10 | yes | build proceeds; reviewer is named before Gate A and Gate B sign-off | open |
| H-20 | Maintenance billing model (per job, per visit, time and materials), SLA targets, rate cards, parts markup | Owner | P3-01, P3-04 | no | none | open |
| H-21 | Salvaged material valuation: zero or estimated value | Accountant | P1-12 | yes | zero value | open |
| H-22 | Purchase price variance handling (bill price differs from receipt price) | Accountant | P2-05 | yes | variance charged to project cost if issued, else to an overhead cost code | answered |
| H-23 | Over-receipt tolerance and three-way match tolerances | Owner | P1-11, P2-05 | yes | 0% over-receipt; match tolerance 0 | answered |
| H-24 | Backdating allowance (days a business date may precede today) | Owner | P1-01 | yes | 3 days | answered |
| H-25 | Cost code structure (hierarchy and codes) | Owner, accountant | P1-05 | no | none | answered |
| H-26 | Units of measure and conversions | Owner | P1-05 | yes | standard construction units (nos, bag, kg, ton, m, ft, sqft, sqm, cuft, cum, day, hour, ls) | open |
| H-27 | Document number series and starting numbers continuing the paper series | Accountant | P1-01 | no | none | answered |
| H-28 | Advance recovery method on stage invoices (proportional or fixed percentage) | Accountant | P2-02 | yes | proportional to invoice share of contract value | answered |
| H-29 | Labour cost difference handling (allocated attendance cost vs final payroll): spread to projects or overhead | Accountant | P2-07 | yes | spread pro-rata to the projects in the payroll month | answered |
| H-30 | Aging buckets and credit follow-up rules | Owner | P2-04 | yes | 0-30, 31-60, 61-90, 90+ days | answered |

## Answers

Details behind each `answered` row. Dated 2026-10-24, given by the owner. Nothing here is a secret or a real tax number.

- **H-01** The company is registered with FBR only. No PRA registration yet; the system must allow adding one later. Registration numbers are entered by the owner in the company profile screen (P1-05), not stored in the repository.
- **H-04** Invoice format `INV-YYYY-NNNN` (example `INV-2026-0001`). An invoice may or may not carry sales tax, because for some jobs the client pays the tax directly; such an invoice is issued without tax and says so. Assumed, not yet confirmed by the accountant: one series for all invoices, gapless, a cancelled invoice keeps its number. Series settings are editable from the UI (P1-01), so the accountant can change them.
- **H-09** The owner approves every approval item (requisition, purchase order, expense, payment, quotation, write-off). No amount limits and no margin floor for now. The matrix must stay editable from the UI. The creator of a payment still cannot approve it.
- **H-10** Roles: owner (sees everything), admin (sees everything, manages users and settings), accountant, project manager, estimator, procurement officer, store keeper, site supervisor, plus a labour role with trade categories (electrician, plumber and so on). One person may hold several roles. Labourers can log in and see only their own records (see the proposal in `CHANGES.md`). Names of people are entered as users in the UI, not stored in the repository.
- **H-24** Backdating allowance 3 days. Older dates need approval from an admin user (see the proposal in `CHANGES.md`).
- **H-25** Cost codes: 100 Materials, 200 Labour, 300 Subcontractors, 400 Equipment and tools, 500 Site expenses (transport, food, small items), 600 Other. Sub-codes (for example 101 Cement, 102 Steel, 103 Bricks) are added from the UI.
- **H-27** Prefixes `INV`, `QUO`, `PO`, `PV`, `RV`, `VAR`, each as `PREFIX-YYYY-0001`, all starting from 0001. Prefix, padding and next number are editable from the UI. A change affects new documents only.
- **H-05** Answered provisionally 2026-10-27. The owner accepted the draft in `docs/decisions/chart-of-accounts-draft.md` as it stands, to unblock the build; the accountant has not reviewed it yet. The owner may change it later, so the chart must be editable from the UI (see the proposal in `CHANGES.md`). When the accountant reviews it, any changes are made from the UI, not by a new build.
- **H-12** Partly answered 2026-10-25. Permanent workers and supervisors are paid monthly; daily-wage and contractor workers daily. Contractor labour is paid as a total on the contractor bill and not tracked per worker. Rates must be configurable, not fixed. Worker records are entered by an admin from the screen. Defaults and open points are in `docs/decisions/h12-h15-owner-answers-and-defaults.md`. Status stays `open` until real rates are loaded.
- **H-15** Partly answered 2026-10-25. Common jobs are demolition and restructuring (about 10 a year each); pricing is both lump sum and per unit; material prices come from the market. Template contents and the percentages were left to us; assumed values are in `docs/decisions/h12-h15-owner-answers-and-defaults.md`. Status stays `open` until the owner confirms real templates and rates.
- **H-02, H-03, H-13, H-19** Partly answered 2026-10-30 by the owner. FBR only; the bill carries 8% tax. A withholding of 8% on the bill was also mentioned (to confirm what it is). Withholding we apply to vendors and subcontractors, opening data, the independent reviewer and the remaining Phase 2 inputs use defaults, to be revisited. Everything must stay configurable and extensible. Details and assumptions in `docs/decisions/phase2-owner-answers-and-defaults.md`. Statuses stay `open` until the accountant confirms.

### Owner answers of 2026-11-15
The owner reviewed the Phase 2 list and chose the stated default for each input below. These rows are now `answered`. Everything stays configurable from the UI, and a change affects new documents only.

- **H-02** Default: FBR only, one sales-tax rule of 8% on services, entered as data (not seeded), effective-dated and editable. A second authority or other rates are added later as new rules.
- **H-03** Default: no withholding rules until an admin enters them. The "8% in bill" from 2026-10-30 is still read as the sales tax itself (H-02); the accountant should confirm that when reviewing.
- **H-06** Default: the fiscal year starts in July.
- **H-08** Default: tax is rounded per document.
- **H-11** Default: 26 working days a month and net pay rounded to the nearest rupee. **The overtime multiplier starts at 1.5 but must be a variable, configurable setting** (an admin can change it, and a change must not rewrite approved wage sheets).
- **H-22** Default: a bill-versus-receipt price difference goes to the project cost if the goods were issued, otherwise to an overhead cost code.
- **H-23** Default: 0% over-receipt and a match tolerance of 0.
- **H-28** Default: advance recovery is proportional to the invoice's share of the contract value. **Configurable:** an admin can switch the method (for example to a fixed percentage) from settings, so the method is a setting and not fixed in code.
- **H-29** Default: a difference between allocated attendance cost and final payroll is spread pro-rata across the projects in the payroll month.
- **H-30** Default: ageing buckets 0-30, 31-60, 61-90 and 90+ days, editable.

**Still `open` on purpose (gate prerequisites, not decisions):**
- **H-13** Default confirmed: the build uses synthetic opening data through the import templates. Real balances must still be loaded before Gate B.
- **H-19** Default confirmed: the build proceeds. The independent reviewer must be named before Gate A and Gate B sign-off.
- **H-12** Real pay rates are still to be supplied.

### Owner choices of 2026-11-15 for the three inputs that stay open
The owner chose the approach for each. The rows stay `open` until the real facts are supplied.

- **H-13 Opening data: start fresh with open items only.** No history is loaded. Only the items still outstanding at the cut-over date are loaded through the import templates: unpaid client invoices, unpaid vendor bills, open projects, and the current cash, bank, advance, post-dated cheque and stock balances. Past totals are not rebuilt. **To supply before Gate B (P2-10):** the cut-over date and the accountant's outstanding items in the import templates.
- **H-19 Independent reviewer: a chartered accountant or audit firm for the financial logic, plus a security specialist for access control.** Two reviewers, one for tax, billing, payments and payroll, one for roles, approvals and data access. **To supply before Gate B sign-off:** the names or firms. (Gate A needs the operations and access review.)
- **H-12 Real pay rates: one spreadsheet loaded with the Worker pay rates importer.** The list has each worker with the pay basis, amount and start date. Old rates stay on record and a raise is a new dated rate. **To supply:** the worker list with rates.
