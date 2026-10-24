---
id: P2-02
title: Stage billing, advances and credit notes
phase: 2
module: billing
status: not-started
depends_on: [P2-01, P1-08, P1-09, P1-10, P1-03]
requires_inputs: [H-04, H-28]
---

# P2-02 Stage billing, advances and credit notes

## 1. Purpose
Bill clients against the lump-sum contract by stages, record and recover advances, bill approved variations, and issue tax invoices and credit notes with the correct authority, registration number and numbering.

## 2. Boundary
- Owns: tables `bil_*`, module `billing`, invoice print model and PDF.
- Provides: `getInvoice`, `listInvoicesForProject`, `getBilledAmount(projectId)`, invoice source provider registry (`registerInvoiceSource(type, provider)`), events `invoice.issued`, `invoice.cancelled`, `creditnote.issued`; view `bil_v_invoices` for receivables.
- Consumes: quotations (stage schedule), projects (contract value), variations (approved), tax engine, approvals, kernel numbering, files.
- Must not: record payments (P2-04), post cash or touch the cost ledger.
- Out of scope: retention (BACKLOG), running-bill measurement sheets, work-order and service invoices (added by P3-04 through the source registry), e-invoicing.

## 3. Data model
- `bil_billing_schedule(id, project_id, stage_no, name, basis_percent, amount numeric(18,2), source quotation|variation|manual, source_id, status planned|invoiced|cancelled)`.
- `bil_invoices(id, number, series_code, authority_code, source_type project_stage|advance|variation, project_id, party_id, invoice_date, due_date, status draft|pending_approval|approved|issued|cancelled, base_amount, advance_recovery numeric(18,2), taxable_base numeric(18,2), tax_total numeric(18,2), gross_total numeric(18,2), withholding_expected numeric(18,2), tax_snapshot jsonb, registration_number, notes, ...base)`.
- `bil_invoice_lines(id, invoice_id, schedule_id nullable, description, amount numeric(18,2), supply_kind goods|services, nature)`.
- `bil_advances(id, project_id, party_id, amount, received_on nullable, applied numeric(18,2), status requested|received|fully_applied|refunded)`.
- `bil_credit_notes(id, number, invoice_id, reason, base_amount, tax_total, gross_total, issued_on, tax_snapshot, status draft|issued)`.

## 4. Business rules
- BR-1 The billing schedule is created from the accepted quotation stages (percent of original contract value) and extended by each approved variation (one stage per variation, amount = price impact). Manual schedule edits require the `billing.schedule.manage` permission and approval; the sum of schedule amounts must equal the current contract value (original + approved variations) before any invoice for that project can be issued.
- BR-2 An invoice is created for one or more planned stages of one project; the party is the project's client; the authority and registration come from the tax engine using the project location (BR-1 of P2-01); issuing is blocked if the tax engine cannot resolve rules.
- BR-3 **Advance recovery** (H-28, default proportional): the recovery on an invoice = advance received and not yet applied x (invoice base / contract value remaining unbilled before this invoice), capped at the unapplied advance and at the invoice base; the alternative `fixed_percent` method recovers a configured percent of each invoice base; recovery reduces the taxable base only if the accountant setting `tax_on_advance_at_receipt` is false (default true means advance tax was charged at receipt and the invoice taxes the full base) — the invoice states which.
- BR-4 Tax is computed by the tax engine on the taxable base and stored as a snapshot; gross total = taxable base + tax total (advance recovery applied as a deduction line when tax was charged at receipt); `withholding_expected` is computed from client withholding rules (informational until receipt).
- BR-5 Numbering: series per authority (from H-04), allocated at issue (not at draft) in the issuing transaction; if the series is gapless, issued numbers are never reused or deleted and cancellation is by credit note only.
- BR-6 Approval through the engine (doc type `invoice`, amount = gross total) before issue; issuing locks the invoice, marks the stages `invoiced`, and emits `invoice.issued` once.
- BR-7 Cumulative billing may not exceed the current contract value; the check includes advances and credit notes (net billed = invoices - credit notes).
- BR-8 Advance requests: an advance invoice (source `advance`) bills a stated amount (typically mobilization); on receipt in P2-04 the advance becomes `received`; unapplied advance appears as a customer credit.
- BR-9 Credit notes reference an issued invoice; the credited amount cannot exceed the invoice gross less prior credit notes; tax is reversed using the original snapshot rates; issuing is approved and numbered from the credit-note series; stages return to `planned` when fully credited.
- BR-10 Due date = invoice date + payment terms days from the quotation terms or setting `default_payment_days`.
- BR-11 The print model shows company profile, the registration number for the authority, client NTN/STRN where present, stage description, base, advance recovery, tax lines with rates, total, withholding note and payment instructions; internal data never appears.
- BR-12 Invoice sources are pluggable: a provider supplies lines, supply kind and project or cost-object reference; `project_stage` is the only provider in this spec.

## 5. API and UI
- `GET/PUT /billing/schedule/:projectId`; CRUD `/billing/invoices`; `POST /billing/invoices/:id/submit|issue|cancel-by-credit-note`; `POST /billing/advances`; `GET /billing/invoices/:id/print-model|pdf`; `GET /billing/projects/:id/summary`.
- Screens: billing schedule editor, invoice builder with tax preview, advance tracker, credit note dialog, invoice list.

## 6. Permissions
`billing.schedule.read|manage`, `billing.invoice.read|create|issue` (accountant; management read and approve), `billing.creditnote.create` (accountant), `billing.advance.manage` (accountant).

## 7. Test requirements
- T-1 Schedule building from quotation plus variations; sum equals contract value; edits blocked when the sum differs.
- T-2 Worked invoice examples: stage 30% of 5,000,000 with and without advance recovery under both methods; tax on taxable base using synthetic rules; gross totals to the paisa.
- T-3 Property test: for random schedules and advances, total recovered never exceeds the advance, cumulative base billed never exceeds contract value, and invoice totals equal base plus tax.
- T-4 Numbering at issue only; gapless behavior; cancellation only by credit note.
- T-5 State machine exhaustive; approval integration; locked after issue.
- T-6 Credit note limits, tax reversal using snapshot, stage release.
- T-7 Tax unavailable blocks issue with a clear message.
- T-8 Print model excludes internal data; golden print-model test for an Islamabad and a Punjab invoice (different authority and registration).
- T-9 Route contract tests, repository integration tests, component tests, Playwright: quote accepted to invoice issued; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 An accepted quotation yields a billing schedule; issuing stage invoices respects contract value and advances.
- AC-2 Islamabad and Punjab projects produce invoices under different authorities and registration numbers.
- AC-3 Cancelling an issued invoice is possible only through a credit note.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-04 (numbering rules; stop if unanswered since it is legal), H-28 (default proportional allowed).
