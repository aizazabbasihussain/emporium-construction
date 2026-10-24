---
id: P2-01
title: Tax engine
phase: 2
module: tax
status: not-started
depends_on: [P1-05]
requires_inputs: [H-01, H-02, H-03, H-08]
---

# P2-01 Tax engine

## 1. Purpose
Calculate sales tax and withholding tax on invoices, vendor bills and payments from effective-dated rules by authority, project location and nature of supply, so no rate is ever hard-coded.

## 2. Boundary
- Owns: tables `tax_*`, `packages/domain/tax`, module `tax`.
- Provides: `resolveAuthority({location, supplyKind, date})`, `calculateSalesTax(input)`, `calculateWithholding(input)`, `getTaxRules(date)`, `taxReportData(authority, period)`; value object `TaxResult` (base, tax lines, total).
- Consumes: master data (registrations per authority, locations, parties), kernel settings (rounding mode).
- Must not: create invoices, bills or payments; must not contain any rate or rule value in code or seed data.
- Out of scope: return filing, e-invoicing or portal integration (BACKLOG), tax on stock valuation.

## 3. Data model
- `tax_authorities(code pk, name, registration_type)` seeded: `FBR`, `PRA`.
- `tax_region_map(region islamabad|punjab, supply_kind goods|services, authority_code, effective_from, effective_to)`.
- `tax_rules(id, authority_code, supply_kind goods|services, nature text nullable, rate_percent numeric(9,4), tax_code, effective_from date, effective_to date nullable, note)`.
- `tax_withholding_rules(id, direction client_withholds|we_withhold, authority_code, party_type nullable, nature, rate_percent, base on_invoice_total|on_tax_amount|on_base, effective_from, effective_to nullable, note)`.
- `tax_settings(key, value)`: `rounding_mode per_line|per_document` (H-08, default per_document), `prices_include_tax default false`.

## 4. Business rules
- BR-1 Authority resolution: from the project's location and the supply kind on the document date through `tax_region_map`; no mapping or no registration for that authority on the date is an error that blocks the document (never silently untaxed).
- BR-2 Rate resolution: the single active rule for `(authority, supply_kind, nature)` on the date, falling back to the rule with null nature; zero or multiple matches are an error; overlapping effective ranges are rejected on save.
- BR-3 Calculation: with exclusive prices, line tax = line base x rate; with inclusive prices (`prices_include_tax`), base = gross / (1 + rate) and tax = gross - base. Rounding half-up to 2 decimals: per line when `per_line`, otherwise on the summed document tax per rate and authority; document total = base total + tax total, exact in both modes.
- BR-4 Withholding: computed per rule on the stated base; `client_withholds` creates an expected withholding amount on an invoice (receivable reduced when the client pays net and issues a certificate); `we_withhold` creates a deduction on a vendor or subcontractor payment. Amounts round half-up to 2 decimals.
- BR-5 Rules are never edited in place once used: changes create a new rule with a new `effective_from` and close the previous the day before; rules referenced by posted documents cannot be deleted.
- BR-6 Rule changes require the `tax.rule.manage` permission and approval through the engine (doc type `tax_rule`); they are audited.
- BR-7 All outputs state the rule ids and rates used, so each document stores a tax snapshot and later rule changes never alter issued documents.
- BR-8 Tax report data: output tax (invoices and credit notes) and input tax (vendor bills) by authority and month, with base, tax, document count; withholding deducted and suffered by authority and month; all derived from stored snapshots through the owning modules' views.
- BR-9 The system ships with no rates; an environment without accepted rules (H-02, H-03) refuses to issue taxable documents, with a message naming the missing rule.

## 5. API and UI
- `GET /tax/rules`, `POST /tax/rules`, `GET /tax/withholding-rules`, `POST /tax/withholding-rules`; `POST /tax/calculate` (preview for UI forms); `GET /tax/reports?authority&month`.
- Screens: authorities and region map, rules list with effective dates, withholding rules, tax report per authority and month.

## 6. Permissions
`tax.rule.read` (accountant, management), `tax.rule.manage` (accountant), `tax.report.read` (accountant, management).

## 7. Test requirements
- T-1 Authority resolution matrix (both regions, both supply kinds, dates across a mapping change, missing mapping, missing registration).
- T-2 Rate selection with nature fallback, overlap rejection, no match and multiple matches.
- T-3 Calculation worked examples (exclusive and inclusive, several rates on one document, per-line vs per-document rounding showing the difference on a crafted example); property test: total = base + tax exactly, and inclusive then exclusive round-trips within one paisa.
- T-4 Withholding on each base type; zero rate; multiple rules.
- T-5 Immutability: used rules cannot be edited or deleted; changes create successor rules.
- T-6 Refusal to calculate without rules; snapshot contents.
- T-7 Report aggregation against scripted snapshots.
- T-8 Route contract tests, repository integration tests, component tests; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 With accountant-supplied test rules, a document in Islamabad and one in Punjab resolve to different authorities and rates.
- AC-2 No tax rate appears anywhere in source code or default seeds (repository scan test).
- AC-3 A later rule change never alters a previously issued document's tax.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-01, H-02, H-03: required; unanswered means stop before real rules (tests use synthetic rules). H-08: default per document allowed.
