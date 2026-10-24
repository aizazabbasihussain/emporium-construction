---
id: P1-21
title: Phase 1 acceptance (Gate A, operational pilot)
phase: 1
module: acceptance
status: not-started
depends_on: [P1-10, P1-13, P1-18, P1-19, P1-20]
requires_inputs: [H-19]
---

# P1-21 Phase 1 acceptance (Gate A, operational pilot)

## 1. Purpose
Prove that the Phase 1 modules work together as one business flow, are secure, and are ready for a pilot with synthetic or private-client data. This is not a financial go-live (Gate B) and not a government go-live (Gate C).

## 2. Boundary
- Owns: end-to-end scenario tests, the synthetic seed generator, pilot documents under `docs/pilot/`.
- Provides: `pnpm seed:synthetic`, `pnpm e2e`, the Gate A report.
- Consumes: public interfaces of all Phase 1 modules.
- Must not: add features or change module behavior; defects found are fixed in the owning module's spec through a new branch.
- Out of scope: billing, payments and tax (Phase 2), real data loading, hosting changes.

## 3. Data model
None. Test fixtures and documents only.

## 4. Business rules
- BR-1 The synthetic seed generator produces a deterministic company: 30 clients and vendors, 200 items in categories, 60 cost codes, 50 workers in 6 teams with 3 supervisors, 12 users across roles, 6 projects (private and one government-tagged only when the government flag is on) and their budgets; no real names, CNICs or phone numbers.
- BR-2 The Gate A end-to-end scenario runs through the real API: lead, site visit, estimate from a template, quotation with margin approval, acceptance, project creation, requisition, RFQ, PO approval, partial GRN into a store, issue to project (weighted average and then again after switching to FIFO), client-supplied material receipt and use, variation approved, expense claim approved and posted, supervisor DPR with photos, attendance sheets for a week approved, monthly wage sheet approved, project cost report.
- BR-3 Expected figures for every step are asserted to the paisa against a hand-calculated worksheet stored in `docs/pilot/gate-a-expected.md`.
- BR-4 Security checks: every table has RLS deny-all; every route requires authentication; a permission matrix test iterates all routes and roles and compares to the expected matrix file; supervisors cannot read other projects, rates or costs; government project creation fails when the flag is off.
- BR-5 Performance sanity on synthetic data (6 projects, 50 workers, 3 months): list endpoints respond under 500 ms at the 95th percentile on the test database; wage calculation for 50 workers completes under 3 seconds; ledger and stock queries use indexes (query plans asserted for the five heaviest queries).
- BR-6 Integrity checks after the scenario: inventory balances equal ledger sums; valuation conservation holds; project cost summary equals the sum of source entries; no orphan outbox events; no failed events.
- BR-7 Backup and restore rehearsal of the pilot database: dump, restore into a fresh database, rerun integrity checks.
- BR-8 Independent review: a named reviewer (H-19) receives a review pack (architecture summary, permission matrix, RLS report, ledger and valuation tests list) and records findings in `docs/pilot/review-gate-a.md`; critical findings must be fixed before pilot with private-client data.
- BR-9 User acceptance: owner and each role walk their checklist in `docs/pilot/uat-checklist.md` on synthetic data and sign off in the same file.
- BR-10 Gate A report `docs/pilot/gate-a-report.md` lists: spec status table (all Phase 1 specs done), coverage summary, test counts, open defects, review findings, UAT sign-offs, and the explicit statement that financial go-live and government data are not yet permitted.

## 5. API and UI
None new. Commands: `pnpm seed:synthetic`, `pnpm e2e`, `pnpm gate:a` (runs all checks and writes the report skeleton).

## 6. Permissions
None.

## 7. Test requirements
- T-1 End-to-end scenario BR-2 with assertions from BR-3.
- T-2 Permission matrix test over all routes and roles.
- T-3 RLS completeness test; unauthenticated route sweep.
- T-4 Performance tests with query plan assertions.
- T-5 Integrity checker tests (seeded faults are detected: negative balance, ledger/balance mismatch, value drift).
- T-6 Seed generator determinism (same output twice) and absence of real-data patterns.
- T-7 Backup and restore script test on the test database.
- T-8 Playwright smoke tests for the five most important screens per role.

## 8. Acceptance criteria
- AC-1 `pnpm gate:a` passes on a clean clone and produces the report.
- AC-2 All figures in the scenario match the worksheet to the paisa.
- AC-3 The permission matrix test passes with zero unexpected grants.
- AC-4 Restore rehearsal passes the integrity checks.
- AC-5 Review findings are recorded; no unresolved critical finding.
- AC-6 UAT checklist signed by owner and role representatives.
- AC-7 Definition of Done satisfied.

## 9. Open inputs
H-19: independent reviewer. Unanswered: the review step stays open and Gate A cannot be declared passed (pilot may still run on synthetic data only).
