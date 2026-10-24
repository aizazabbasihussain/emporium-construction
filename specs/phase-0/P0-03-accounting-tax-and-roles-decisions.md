---
id: P0-03
title: Accounting, tax and roles decision records
phase: 0
module: decisions
status: not-started
depends_on: [P0-02]
requires_inputs: [H-01, H-04, H-05, H-07, H-09, H-10, H-25, H-27]
---

# P0-03 Accounting, tax and roles decision records

## 1. Purpose
Turn the open business decisions into signed-off, machine-readable configuration (chart of accounts, tax matrix, role and approval matrix, valuation defaults, numbering series, cost codes) that later specs load as seed data.

## 2. Boundary
- Owns: `docs/decisions/ADR-*.md`, `packages/db/seeds/*.csv` templates and validators, `pnpm decisions:check`.
- Provides: validated seed files consumed by P1-01 (series), P1-02 (roles), P1-03 (approval rules), P1-05 (cost codes, company registrations), P1-13 (valuation policy), P2-01 (tax rules), P2-09 (chart of accounts).
- Consumes: human answers to the listed inputs.
- Must not: decide any business value itself, or invent rates, limits or account codes.
- Out of scope: loading the seeds into the database (done by each consuming spec).

## 3. Data model
Files only.
- ADR-001 Chart of accounts: `chart_of_accounts.csv` (code, name, type in asset|liability|equity|income|expense, parent_code, active).
- ADR-002 Tax matrix: `tax_authorities.csv` (code, name, registration_number), `tax_rules.csv` (authority, applies_to goods|services, region, rate_percent, effective_from, effective_to, note), `withholding_rules.csv` (direction client_withholds|we_withhold, party_type, nature, rate_percent, base, effective_from, effective_to).
- ADR-003 Roles and approvals: `roles.csv`, `role_permissions.csv`, `approval_rules.csv` (document_type, min_amount, max_amount, steps with role per step).
- ADR-004 Valuation policy: `valuation_policy.csv` (scope company|category, category_code, method weighted_average|fifo, effective_from).
- ADR-005 Numbering series: `number_series.csv` (code, prefix, padding, reset_yearly, gapless, start_value).
- ADR-006 Rounding rules: `rounding.csv` (context, mode, decimals).
- ADR-007 Cost code structure: `cost_codes.csv` (code, name, parent_code, kind material|labour|subcontract|equipment|overhead).
- ADR-008 Salvage and price variance policies.
Each ADR records: decision, decided by, date, effect on specs, status `pending` or `accepted`.

## 4. Business rules
- BR-1 Every CSV has a header-only template with example synthetic rows in `docs/decisions/examples/`.
- BR-2 Validators reject: duplicate codes, unknown parent codes, cycles in hierarchies, unknown enum values, rates outside 0-100, overlapping effective ranges for the same authority and rule, `effective_to` before `effective_from`, negative amounts, `min_amount` greater than `max_amount`, gaps or overlaps between consecutive approval amount bands for a document type.
- BR-3 An ADR stays `pending` until the human supplies the answers; downstream specs that require the matching H-id follow the register (stop unless a default is allowed).
- BR-4 Valuation policy validation: exactly one company-scope row effective on the first date; category rows reference existing item category codes at load time (checked in P1-13).
- BR-5 Withholding and tax rule files must contain only values supplied by the accountant; the repository ships with empty files (header only) until then.
- BR-6 ADRs must name who approved (accountant or owner) and the approval date before status `accepted`.

## 5. API and UI
`pnpm decisions:check` validates every CSV in `packages/db/seeds` and every ADR status block.

## 6. Permissions
None.

## 7. Test requirements
- T-1 One test per validator rule in BR-2 (accepting and rejecting fixtures).
- T-2 Header-only files pass validation as `pending`.
- T-3 An `accepted` ADR without approver or date fails.
- T-4 Property test: random non-overlapping rule sets pass; any generated overlap fails.
- T-5 100% coverage on validator logic.

## 8. Acceptance criteria
- AC-1 All ADRs and templates exist; checker passes with header-only files.
- AC-2 With synthetic example data, the checker passes; with each seeded fault, it fails with a clear message naming file and row.
- AC-3 No rate, limit or account code is committed unless the register shows its input as answered.
- AC-4 Definition of Done satisfied (database items not applicable).

## 9. Open inputs
H-01, H-04, H-05, H-07 (default allowed), H-09, H-10, H-25, H-27. Unanswered inputs leave the matching file header-only and the ADR `pending`.
