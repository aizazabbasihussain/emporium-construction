---
id: P1-14
title: Site expenses and petty cash
phase: 1
module: expenses
status: done
depends_on: [P1-09, P1-03, P1-04]
requires_inputs: [H-09]
---

# P1-14 Site expenses and petty cash

## 1. Purpose
Handle small site spending: cash advances to custodians, expense claims with receipts, approval, and posting of approved claims to project or overhead cost, without treating unapproved claims as cost.

## 2. Boundary
- Owns: tables `exp_*`, module `expenses`.
- Provides: `getCustodianBalance(userId)`, events `expense.approved`, `expense.posted`, `advance.issued`; cost postings to the cost ledger.
- Consumes: projects (`postCost`, scope), approvals, files, identity, master data (cost codes).
- Must not: move cash or bank balances (cash book arrives in P2-03, which consumes `advance.issued` and `expense.posted`).
- Out of scope: reimbursements and payments through the cash book (P2-03), vendor bills (P2-05).

## 3. Data model
- `exp_custodians(user_id pk, float_limit numeric(18,2), active)`.
- `exp_advances(id, number, custodian_id, amount, issued_on, issued_by, purpose, status issued|settled|cancelled, ...base)`.
- `exp_claims(id, number, claimant_id, submitted_on, status draft|submitted|approved|rejected|returned|posted|cancelled, total numeric(18,2), note, ...base)`; `exp_claim_lines(id, claim_id, expense_date, category, description, cost_object_type project|overhead, cost_object_id nullable, cost_code_id, amount numeric(18,2), receipt_file_id nullable)`.
- `exp_categories(code, name, default_cost_code_id, receipt_required bool, max_without_receipt numeric(18,2))`.

## 4. Business rules
- BR-1 Custodian balance = sum of advances issued - sum of posted and approved claim totals attributed to that custodian; a negative balance means the company owes the claimant (reported, not blocked).
- BR-2 A claim line needs a date not in the future (backdating limit applies), amount greater than zero, cost object and cost code; project lines require an active project the claimant is scoped to (supervisors) or any project (office roles).
- BR-3 Receipt rule: if the category requires a receipt and the amount exceeds `max_without_receipt`, a receipt attachment is mandatory to submit.
- BR-4 Claim total = sum of line amounts; submission through the approval engine (doc type `expense_claim`); self-approval is blocked by the engine.
- BR-5 On approval: one cost entry per line with status `approved`, idempotency key `exp:<line id>`; the claim becomes `approved`.
- BR-6 Posting by the accountant (`expenses.claim.post`) moves each entry to `posted` and the claim to `posted`; posting is allowed only for approved claims; posting emits `expense.posted` once.
- BR-7 A rejected or returned claim posts nothing; cancelling an approved, unposted claim reverses its cost entries; a posted claim can only be reversed by the accountant with a reason (reversal entries).
- BR-8 Advance issue records custodian, amount and purpose; settlement marks an advance settled when the custodian balance returns to zero or the accountant settles it manually with a note.
- BR-9 Duplicate guard: a line with the same claimant, date, amount and category within 7 days produces a warning that must be acknowledged on submit.

## 5. API and UI
- CRUD `/expenses/claims`; `POST /expenses/claims/:id/submit|post|cancel|reverse`; `/expenses/advances` (issue, list, settle); `GET /expenses/custodians/:id/balance`; `GET/PUT /expenses/categories`.
- Screens: claim form with line grid and receipt capture (mobile friendly), my claims, advances list, custodian balances, posting queue for accountant.

## 6. Permissions
`expenses.claim.create|read-own` (supervisor, project_manager, storekeeper), `expenses.claim.read-all` (accountant, management), `expenses.claim.post|reverse` (accountant), `expenses.advance.issue` (accountant), `expenses.category.manage` (accountant).

## 7. Test requirements
- T-1 Balance calculation across advances and claims in each status.
- T-2 Receipt rule at the threshold boundary; future date and backdating limits.
- T-3 State machine exhaustive; approve then post flow; reject and return post nothing.
- T-4 Cost entries created once with right status; cancel and reverse paths produce correct reversals; replay safe.
- T-5 Duplicate warning logic.
- T-6 Supervisor scope on project lines.
- T-7 Property test: sum of cost entries equals the claim total for random line sets; reversal nets to zero.
- T-8 Route contract tests, repository integration tests, component tests for the claim grid; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 An expense claim is submitted, approved (project cost status `approved`), posted by the accountant (status `posted`).
- AC-2 Unapproved claims never appear as cost.
- AC-3 Custodian balances match the scripted scenario.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-09: approval limits for claims. Unanswered: stop.
