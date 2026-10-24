---
id: P2-10
title: Phase 2 acceptance (Gate B, financial go-live)
phase: 2
module: acceptance-finance
status: not-started
depends_on: [P2-08, P2-09, P1-21]
requires_inputs: [H-13, H-19, H-02, H-03, H-04]
---

# P2-10 Phase 2 acceptance (Gate B, financial go-live)

## 1. Purpose
Prove that billing, receivables, payables, payroll, the cash book and project profitability reconcile with each other and with the opening data, so the company can run its real private-client business on the system. Government data is still not permitted (Gate C).

## 2. Boundary
- Owns: finance scenario tests, reconciliation tooling, cutover documents under `docs/cutover/`.
- Provides: `pnpm gate:b`, the Gate B report, the opening-balance verification report.
- Consumes: public interfaces of all Phase 1 and 2 modules, the import framework.
- Must not: change module behavior; defects are fixed through the owning spec.
- Out of scope: Pakistan hosting (Phase 4), maintenance (Phase 3), live data entry.

## 3. Data model
None. Fixtures, scripts and documents.

## 4. Business rules
- BR-1 **Opening data load rehearsal:** the opening data templates (H-13) are loaded in a clean database through the import framework in dependency order (parties, items, workers, cash and bank accounts, opening vendor and customer balances, advances, PDCs in hand, open projects with cost to date, opening stock through GRN-less receipts at valued cost); the verification report compares each total with the accountant's control sheet (`docs/cutover/opening-control-sheet.md`), difference must be zero.
- BR-2 **Finance scenario** through the real API: advance invoice and receipt; stage invoices in Islamabad and Punjab under different authorities with client withholding; credit note; PDC received, one cleared and one bounced; vendor bills with PO and GRN match and a price variance; a subcontract certificate with back-charge; vendor and subcontractor payments by cheque, bank transfer and cash; monthly wages and payroll run paid; cash book reconciliation with a statement; project profitability and all accountant exports.
- BR-3 **Reconciliations (all must hold to the paisa):** customer ledger totals = open invoices - allocated receipts; vendor ledger totals = posted bills - payments; cash book balance per account = opening + movements; bank reconciliation difference zero; stock valuation total (valuation engine) = sum of company stock by item and store at valuation cost, and inventory balances = ledger sums; cost ledger posted totals per project = source documents (bills, payroll, expenses, stock issues); tax report totals = sum of invoice and bill tax snapshots; project profitability figures = hand-calculated worksheet; each export control total = owning module total; payroll total paid = cash book payments for payroll.
- BR-4 **Tax test pack:** the accountant supplies at least 10 sample documents with expected tax and withholding; the engine's results are compared; every sample must match; the accountant signs `docs/cutover/tax-signoff.md` (H-02, H-03, H-04 answered).
- BR-5 **Security and permission re-check** for finance routes: permission matrix test extended to Phase 2 routes; separation-of-duties tests (creator cannot approve payments or bills); RLS completeness; audit entries exist for every money-changing action in the scenario.
- BR-6 **Backup and restore rehearsal** on the full finance dataset with integrity and reconciliation checks run after restore.
- BR-7 **Independent review** (H-19) of ledger, valuation, tax, payment and permission logic and test lists; findings recorded in `docs/cutover/review-gate-b.md`; no unresolved critical finding.
- BR-8 **Cutover plan** `docs/cutover/plan.md`: cutover date at a clean month boundary, freeze of paper entries, opening load steps, verification steps, rollback plan (restore to pre-load backup), parallel run duration (one to two months) with a daily comparison sheet template, and training schedule per role.
- BR-9 **Parallel run protocol:** for the agreed period, each day the accountant compares cash position, new invoices, receipts, payments, stock issues and attendance counts between paper and system and records differences in `docs/cutover/parallel-run-log.md`; the gate to stop paper requires zero unexplained differences for the last 10 working days.
- BR-10 The Gate B report `docs/cutover/gate-b-report.md` lists spec status, coverage, reconciliation results, tax sign-off, review findings, rehearsal results, and states that government data remains prohibited until Gate C.

## 5. API and UI
Commands: `pnpm gate:b` (scenario, reconciliations, report skeleton), `pnpm cutover:verify-opening` (compares loaded totals to the control sheet).

## 6. Permissions
None.

## 7. Test requirements
- T-1 Finance scenario BR-2 with asserted figures from the worksheet `docs/cutover/gate-b-expected.md`.
- T-2 Each reconciliation in BR-3 as a separate test, including a fault-injection version that must fail (altered ledger row, mismatched total).
- T-3 Opening verification: matching and mismatching control sheets.
- T-4 Tax test pack runner with synthetic samples and the real pack when supplied.
- T-5 Permission matrix and separation-of-duties sweep for Phase 2 routes.
- T-6 Restore rehearsal script test.
- T-7 Parallel run log format checker.

## 8. Acceptance criteria
- AC-1 `pnpm gate:b` passes on a clean clone.
- AC-2 Every reconciliation in BR-3 holds, and each fault-injection test fails as intended.
- AC-3 Opening data totals equal the accountant's control sheet.
- AC-4 Tax samples all match; accountant sign-off recorded.
- AC-5 Independent review recorded with no unresolved critical finding.
- AC-6 Restore rehearsal passes reconciliation.
- AC-7 Cutover plan and parallel-run log are in place and approved by the owner and accountant.
- AC-8 Definition of Done satisfied.

## 9. Open inputs
H-13 (real opening data: needed for the live load; rehearsal runs on synthetic data), H-19, H-02, H-03, H-04. Unanswered: the gate cannot be declared passed; development of tooling may proceed.
