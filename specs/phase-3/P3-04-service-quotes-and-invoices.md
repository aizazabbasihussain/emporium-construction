---
id: P3-04
title: Service quotations and invoicing
phase: 3
module: service-billing
status: not-started
depends_on: [P3-02, P3-03, P2-02, P1-03]
requires_inputs: [H-20]
---

# P3-04 Service quotations and invoicing

## 1. Purpose
Price paid maintenance work (fixed price or time and materials), get client acceptance, and invoice completed, signed-off work orders through the existing billing engine with correct tax.

## 2. Boundary
- Owns: tables `sqt_quotes`, `sqt_quote_lines`, `sqt_rate_cards`, `sqt_rate_card_lines` (prefix `sqt_`), module `service-billing`; registers invoice sources with billing.
- Provides: `getServiceQuote`, event `servicequote.accepted`; registers invoice sources `work_order` and `service_quote` with billing through `registerInvoiceSource`.
- Consumes: work orders (status, cost, sign-off), billing (invoice creation through provider contract), tax engine (via billing), approvals, master data (rates, items), files.
- Must not: duplicate invoice logic, numbering or tax calculation; must not write to `bil_` tables.
- Out of scope: recurring contracts and AMC invoicing (BACKLOG), customer portal payments.

## 3. Data model
- `sqt_rate_cards(id, name, effective_from, effective_to, parts_markup_percent, active)`; `sqt_rate_card_lines(rate_card_id, trade_code, hourly_rate numeric(18,4), daily_rate numeric(18,4))`.
- `sqt_quotes(id, number, request_id nullable, work_order_id nullable, party_id, pricing_model fixed|time_and_materials, status draft|pending_approval|issued|accepted|rejected|expired, price numeric(18,2) nullable, estimate_lines jsonb snapshot, validity_days, issued_at, accepted_at, ...base)`; `sqt_quote_lines(id, quote_id, description, quantity, unit_code, rate numeric(18,4), amount numeric(18,2), line_kind labour|parts|other)`.

## 4. Business rules
- BR-1 Fixed price quotes: lines sum to the price (price may be entered directly with a single line). Time-and-materials quotes: labour lines priced from the rate card by trade and hours, parts lines at item cost plus `parts_markup_percent` rounded half-up per line; the quote is an estimate and the final invoice uses recorded actuals.
- BR-2 Approval through the engine (doc type `service_quote`); acceptance recorded with name and date; accepted quotes can create a work order.
- BR-3 **Invoice source `service_quote`** (fixed price): provides one line at the accepted price when the linked work order is signed off. **Invoice source `work_order`** (time and materials or unquoted billable job): provides lines computed from recorded actuals: labour = sum of attendance-allocated hours or days on the work order converted with the rate card (rule below), parts = issued minus returned parts at item cost plus markup, other direct costs not billed unless flagged `rebillable`.
- BR-4 Labour billing quantity: attendance allocates fractions of worker-days; labour billed = sum of fraction x daily rate from the rate card for the worker's trade (hourly rate is used only when the quote lines specify hours); the line shows trade, days and rate.
- BR-5 Only billable work orders in status `signed_off` can be invoiced; non-billable (warranty) work orders are refused by the provider with a clear message; a work order can be invoiced once unless a credit note frees it.
- BR-6 Supply kind, tax authority and nature for service invoices come from the work order's location and category through the tax engine; the authority registration is the same as project invoices; no tax logic here.
- BR-7 Margin visibility: work order job profit = invoiced base - posted and approved costs; shown to management and accountant only.
- BR-8 Rate card changes are effective-dated and never alter issued invoices.

## 5. API and UI
- CRUD `/service/rate-cards`; CRUD `/service/quotes`; `POST /service/quotes/:id/submit|issue|accept|reject`; `POST /service/work-orders/:id/prepare-invoice` (creates a billing draft through the provider).
- Screens: rate cards, service quote editor, accept dialog, "ready to invoice" list of signed-off work orders.

## 6. Permissions
`service.ratecard.manage` (management, accountant), `service.quote.read|create|submit|accept` (service_coordinator, management), `service.invoice.prepare` (accountant, service_coordinator), `service.jobprofit.read` (management, accountant).

## 7. Test requirements
- T-1 Time-and-materials pricing worked examples (2 plumber days at a rate card rate plus parts at 15% markup), rounding per line; fixed price single-line quote.
- T-2 Provider contract tests with the real billing registry: invoice lines, supply kind, authority; invoicing refused for non-billable and non-signed-off work orders; single invoicing; credit note releases the work order.
- T-3 Rate card effective dates and snapshots; issued invoices unchanged after a rate change.
- T-4 Quote state machine exhaustive; acceptance creates a work order exactly once.
- T-5 Job profit calculation with scripted costs and invoice.
- T-6 Property test: invoice base for T&M equals the sum of labour and parts line amounts for random actuals.
- T-7 Route contract tests, repository integration tests, component tests; Playwright: quote to work order to invoice; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A signed-off billable work order produces a tax invoice through the billing engine in the right authority.
- AC-2 A warranty work order cannot be invoiced.
- AC-3 Job profit matches the scripted figures.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-20: billing model, rate cards, markup. Unanswered: stop; tests use synthetic rate cards.
